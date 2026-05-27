import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TmdbModule } from '../tmdb/tmdb.module';
import { MoviesModule } from '../movies/movies.module';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SyncBootstrap } from './sync.bootstrap';
import { SyncChangesProcessor } from './processors/sync-changes.processor';
import { MovieDetailsProcessor } from './processors/movie-details.processor';
import { MOVIE_DETAILS_QUEUE, SYNC_CHANGES_QUEUE } from './queues';
import type { Env } from '../config/env.schema';

@Module({
  imports: [
    TmdbModule,
    MoviesModule,
    BullModule.registerQueueAsync(
      {
        name: SYNC_CHANGES_QUEUE,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          defaultJobOptions: {
            attempts: config.get('SYNC_JOB_ATTEMPTS', { infer: true }),
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        }),
      },
      {
        name: MOVIE_DETAILS_QUEUE,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          defaultJobOptions: {
            attempts: config.get('SYNC_JOB_ATTEMPTS', { infer: true }),
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: 1000,
            removeOnFail: 500,
          },
        }),
      },
    ),
  ],
  controllers: [SyncController],
  providers: [
    SyncService,
    SyncBootstrap,
    SyncChangesProcessor,
    MovieDetailsProcessor,
  ],
  exports: [SyncService],
})
export class SyncModule {}
