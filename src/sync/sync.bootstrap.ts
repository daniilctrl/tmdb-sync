import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { SyncService } from './sync.service';
import { TmdbClient } from '../tmdb/tmdb.client';
import { MoviesService } from '../movies/movies.service';
import { MOVIE_DETAILS_QUEUE, MovieDetailsJobData } from './queues';
import type { Env } from '../config/env.schema';

@Injectable()
export class SyncBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncBootstrap.name);

  constructor(
    private readonly sync: SyncService,
    private readonly tmdb: TmdbClient,
    private readonly movies: MoviesService,
    @InjectQueue(MOVIE_DETAILS_QUEUE)
    private readonly detailsQueue: Queue<MovieDetailsJobData>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!(await this.sync.needsBootstrap())) return;

    this.run().catch((err) => {
      this.logger.error(`Bootstrap failed: ${(err as Error).message}`);
    });
  }

  private async run(): Promise<void> {
    const pages = this.config.get('BOOTSTRAP_POPULAR_PAGES', { infer: true });
    this.logger.log(`Starting bootstrap: ${pages} pages of /movie/popular`);

    const run = await this.sync.startRun('bootstrap');
    let upserted = 0;
    let failed = 0;
    const allIds: number[] = [];

    try {
      const { genres } = await this.tmdb.fetchGenres();
      await this.movies.upsertGenres(genres);
      const knownGenreIds = new Set(genres.map((g) => g.id));

      for (let page = 1; page <= pages; page += 1) {
        const res = await this.tmdb.fetchPopular(page);
        for (const movie of res.results) {
          try {
            await this.movies.upsertFromPopular(movie, knownGenreIds);
            allIds.push(movie.id);
            upserted += 1;
          } catch (err) {
            failed += 1;
            this.logger.warn(
              `Failed to upsert movie ${movie.id}: ${(err as Error).message}`,
            );
          }
        }
        this.logger.log(
          `Bootstrap: page ${page}/${pages} done (${upserted} upserted)`,
        );
      }

      // Popular gives only a thin projection (no runtime / status / full genres).
      // Queue a detail fetch for each id so the rate-limited worker fills in the rest.
      if (allIds.length > 0) {
        await this.detailsQueue.addBulk(
          allIds.map((id) => ({
            name: 'fetch-details',
            data: { movieId: id },
            opts: {
              jobId: `movie:${id}`,
              removeOnComplete: 1000,
              removeOnFail: 500,
            },
          })),
        );
        this.logger.log(
          `Bootstrap: ${allIds.length} detail jobs queued for enrichment`,
        );
      }

      await this.sync.finishBootstrapRun(run.id, { upserted, failed });
      await this.sync.markBootstrapComplete();
      this.logger.log(
        `Bootstrap completed: ${upserted} upserted, ${failed} failed`,
      );
    } catch (error) {
      await this.sync.failRun(run.id, error as Error);
      throw error;
    }
  }
}
