import { Injectable } from '@nestjs/common';
import { Counter, register } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly moviesUpserted = new Counter({
    name: 'movies_upserted_total',
    help: 'Number of movies upserted from TMDB',
    labelNames: ['source'] as const,
    registers: [register],
  });

  readonly moviesSoftDeleted = new Counter({
    name: 'movies_soft_deleted_total',
    help: 'Number of movies soft-deleted because TMDB returned 404',
    registers: [register],
  });
}
