import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MoviesService } from '../../movies/movies.service';
import { TmdbClient } from '../../tmdb/tmdb.client';
import { SyncService } from '../sync.service';
import { MOVIE_DETAILS_QUEUE, MovieDetailsJobData } from '../queues';

@Processor(MOVIE_DETAILS_QUEUE, {
  concurrency: 10,
  limiter: { max: 40, duration: 1000 },
})
export class MovieDetailsProcessor extends WorkerHost {
  private readonly logger = new Logger(MovieDetailsProcessor.name);

  constructor(
    private readonly tmdb: TmdbClient,
    private readonly movies: MoviesService,
    private readonly sync: SyncService,
  ) {
    super();
  }

  async process(
    job: Job<MovieDetailsJobData>,
  ): Promise<{ result: 'upserted' | 'deleted' }> {
    const { movieId, observedAt } = job.data;
    try {
      const details = await this.tmdb.fetchMovie(movieId);
      await this.movies.upsertFromTmdb(
        details,
        observedAt ? new Date(observedAt) : null,
      );
      return { result: 'upserted' };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 404) {
        await this.movies.softDelete(movieId);
        return { result: 'deleted' };
      }
      this.logger.error(
        `Failed to upsert movie ${movieId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<MovieDetailsJobData>): Promise<void> {
    const { runId } = job.data;
    if (runId !== undefined) {
      await this.sync.incrementRunCounter(runId, 'moviesUpserted');
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<MovieDetailsJobData>): Promise<void> {
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) return;

    const { runId, movieId } = job.data;
    this.logger.error(`Movie ${movieId} permanently failed: ${job.failedReason}`);
    if (runId !== undefined) {
      await this.sync.incrementRunCounter(runId, 'moviesFailed');
    }
  }
}
