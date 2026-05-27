import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncService } from './sync.service';
import { TmdbClient } from '../tmdb/tmdb.client';
import { MoviesService } from '../movies/movies.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class SyncBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncBootstrap.name);

  constructor(
    private readonly sync: SyncService,
    private readonly tmdb: TmdbClient,
    private readonly movies: MoviesService,
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

    try {
      const { genres } = await this.tmdb.fetchGenres();
      await this.movies.upsertGenres(genres);
      const knownGenreIds = new Set(genres.map((g) => g.id));

      for (let page = 1; page <= pages; page += 1) {
        const res = await this.tmdb.fetchPopular(page);
        for (const movie of res.results) {
          try {
            await this.movies.upsertFromPopular(movie, knownGenreIds);
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
