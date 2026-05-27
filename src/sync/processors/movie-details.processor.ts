import { Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MoviesService } from '../../movies/movies.service';
import { TmdbClient } from '../../tmdb/tmdb.client';
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
  ) {
    super();
  }

  async process(
    job: Job<MovieDetailsJobData>,
  ): Promise<{ result: 'upserted' | 'deleted' }> {
    const { movieId, observedAt } = job.data;
    try {
      const details = await this.tmdb.fetchMovie(movieId);
      await this.movies.upsertFromTmdb(details, new Date(observedAt));
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
}
