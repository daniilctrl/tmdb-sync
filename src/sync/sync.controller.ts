import { Controller, Get } from '@nestjs/common';
import { SyncRun } from '@prisma/client';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  async getStatus() {
    const s = await this.sync.getStatus();
    return {
      bootstrap_completed_at: s.bootstrapCompletedAt?.toISOString() ?? null,
      last_change_cursor: s.lastChangeCursor?.toISOString() ?? null,
      currently_running: s.currentlyRunning
        ? serializeRun(s.currentlyRunning)
        : null,
      latest_run: s.latestRun ? serializeRun(s.latestRun) : null,
    };
  }
}

function serializeRun(run: SyncRun) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt?.toISOString() ?? null,
    cursor_from: run.cursorFrom?.toISOString() ?? null,
    cursor_to: run.cursorTo?.toISOString() ?? null,
    movies_upserted: run.moviesUpserted,
    movies_failed: run.moviesFailed,
    error_message: run.errorMessage,
  };
}
