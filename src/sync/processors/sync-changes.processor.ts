import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { SyncService } from '../sync.service';
import { TmdbClient } from '../../tmdb/tmdb.client';
import {
  INCREMENTAL_JOB_ID,
  MOVIE_DETAILS_QUEUE,
  MovieDetailsJobData,
  SYNC_CHANGES_QUEUE,
} from '../queues';

@Processor(SYNC_CHANGES_QUEUE, { concurrency: 1 })
export class SyncChangesProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncChangesProcessor.name);

  constructor(
    @InjectQueue(SYNC_CHANGES_QUEUE) private readonly selfQueue: Queue,
    @InjectQueue(MOVIE_DETAILS_QUEUE)
    private readonly detailsQueue: Queue<MovieDetailsJobData>,
    private readonly sync: SyncService,
    private readonly tmdb: TmdbClient,
  ) {
    super();
  }

  @Cron('*/15 * * * *')
  async tick(): Promise<void> {
    await this.selfQueue.add(
      'tick',
      {},
      {
        jobId: INCREMENTAL_JOB_ID,
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
  }

  async process(): Promise<void> {
    if (await this.sync.needsBootstrap()) {
      this.logger.warn(
        'Bootstrap not completed yet — skipping incremental sync',
      );
      return;
    }

    while (true) {
      const window = await this.sync.openWindow();
      if (!window) break;

      const run = await this.sync.startRun('incremental', window);
      try {
        const ids = await this.tmdb.fetchChangedIds(window);
        this.logger.log(
          `Window ${window.from.toISOString()} → ${window.to.toISOString()}: ${ids.length} changed ids`,
        );

        if (ids.length > 0) {
          await this.detailsQueue.addBulk(
            ids.map((id) => ({
              name: 'fetch-details',
              data: { movieId: id, observedAt: window.to.toISOString() },
              opts: {
                jobId: `movie:${id}`,
                removeOnComplete: 1000,
                removeOnFail: 500,
              },
            })),
          );
        }

        await this.sync.commitWindow(run.id, window, {
          upserted: ids.length,
          failed: 0,
        });
      } catch (error) {
        await this.sync.failRun(run.id, error as Error);
        throw error;
      }
    }
  }
}
