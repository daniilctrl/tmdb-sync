import { Injectable, Logger } from '@nestjs/common';
import { SyncRun, SyncState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChangesWindow } from '../tmdb/tmdb.types';

const CHUNK_DAYS = 7;
const CHUNK_MS = CHUNK_DAYS * 24 * 60 * 60 * 1000;

export type SyncRunKind = 'bootstrap' | 'incremental';

export interface SyncStatusReport {
  bootstrapCompletedAt: Date | null;
  lastChangeCursor: Date | null;
  latestRun: SyncRun | null;
  currentlyRunning: SyncRun | null;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async needsBootstrap(): Promise<boolean> {
    const state = await this.getOrCreateState();
    return state.bootstrapCompletedAt === null;
  }

  async markBootstrapComplete(now: Date = new Date()): Promise<void> {
    await this.prisma.syncState.update({
      where: { id: 1 },
      data: { bootstrapCompletedAt: now, lastChangeCursor: now },
    });
  }

  async openWindow(now: Date = new Date()): Promise<ChangesWindow | null> {
    const state = await this.getOrCreateState();
    const from = state.lastChangeCursor;
    if (from >= now) return null;

    const to = new Date(Math.min(from.getTime() + CHUNK_MS, now.getTime()));
    return { from, to };
  }

  startRun(kind: SyncRunKind, window?: ChangesWindow): Promise<SyncRun> {
    return this.prisma.syncRun.create({
      data: {
        kind,
        status: 'running',
        cursorFrom: window?.from,
        cursorTo: window?.to,
      },
    });
  }

  /**
   * Commits a window's cursor and records how many ids we enqueued.
   * `moviesUpserted` / `moviesFailed` are filled in asynchronously by
   * MovieDetailsProcessor as detail jobs settle — so they may keep
   * growing after the run is marked `success`.
   */
  async commitWindow(
    runId: number,
    window: ChangesWindow,
    idsEnqueued: number,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.syncRun.update({
        where: { id: runId },
        data: {
          status: 'success',
          finishedAt: new Date(),
          idsEnqueued,
        },
      }),
      this.prisma.syncState.update({
        where: { id: 1 },
        data: { lastChangeCursor: window.to },
      }),
    ]);
  }

  async failRun(runId: number, error: Error): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        status: 'error',
        finishedAt: new Date(),
        errorMessage: error.message.slice(0, 2000),
      },
    });
    this.logger.error(`Sync run #${runId} failed: ${error.message}`);
  }

  finishBootstrapRun(
    runId: number,
    counters: { upserted: number; failed: number },
  ): Promise<SyncRun> {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        status: 'success',
        finishedAt: new Date(),
        idsEnqueued: counters.upserted + counters.failed,
        moviesUpserted: counters.upserted,
        moviesFailed: counters.failed,
      },
    });
  }

  incrementRunCounter(
    runId: number,
    field: 'moviesUpserted' | 'moviesFailed',
  ): Promise<unknown> {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: { [field]: { increment: 1 } },
    });
  }

  async getStatus(): Promise<SyncStatusReport> {
    const [state, latest, running] = await Promise.all([
      this.prisma.syncState.findUnique({ where: { id: 1 } }),
      this.prisma.syncRun.findFirst({
        where: { status: { in: ['success', 'error'] } },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.syncRun.findFirst({
        where: { status: 'running' },
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    return {
      bootstrapCompletedAt: state?.bootstrapCompletedAt ?? null,
      lastChangeCursor: state?.lastChangeCursor ?? null,
      latestRun: latest,
      currentlyRunning: running,
    };
  }

  private async getOrCreateState(): Promise<SyncState> {
    const existing = await this.prisma.syncState.findUnique({
      where: { id: 1 },
    });
    if (existing) return existing;
    return this.prisma.syncState.create({
      data: { id: 1, lastChangeCursor: new Date(0) },
    });
  }
}
