export const SYNC_CHANGES_QUEUE = 'sync-changes';
export const MOVIE_DETAILS_QUEUE = 'movie-details';
export const INCREMENTAL_JOB_ID = 'incremental-sync';

export interface MovieDetailsJobData {
  movieId: number;
  observedAt: string;
  /** SyncRun.id whose counters should be incremented on outcome */
  runId?: number;
}
