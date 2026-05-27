/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { SyncService } from './sync.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SyncService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let service: SyncService;

  beforeEach(() => {
    prisma = {
      syncState: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      syncRun: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<PrismaService>;

    service = new SyncService(prisma);
  });

  it('openWindow returns ≤7-day chunk capped at now, or null if caught up', async () => {
    const from = new Date('2024-06-01T00:00:00Z');
    (prisma.syncState.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      lastChangeCursor: from,
      bootstrapCompletedAt: from,
    });

    // 29 дней до now → берётся ровно 7-дневный чанк
    const longGap = await service.openWindow(new Date('2024-06-30T00:00:00Z'));
    expect((longGap!.to.getTime() - longGap!.from.getTime()) / 86_400_000).toBe(
      7,
    );

    // 2.5 дня до now → окно капается на now
    const shortGap = await service.openWindow(new Date('2024-06-03T12:00:00Z'));
    expect(shortGap!.to).toEqual(new Date('2024-06-03T12:00:00Z'));

    // курсор уже на now → null
    (prisma.syncState.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      lastChangeCursor: from,
      bootstrapCompletedAt: from,
    });
    expect(await service.openWindow(from)).toBeNull();
  });

  it('commitWindow updates SyncRun and advances cursor in a single transaction', async () => {
    (prisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    await service.commitWindow(
      42,
      {
        from: new Date('2024-06-01T00:00:00Z'),
        to: new Date('2024-06-08T00:00:00Z'),
      },
      { upserted: 10, failed: 0 },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction as jest.Mock).mock.calls[0][0]).toHaveLength(2);
  });

  it('failRun marks run as error without touching cursor', async () => {
    await service.failRun(42, new Error('TMDB down'));

    expect(prisma.syncRun.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: 'error' }),
    });
    expect(prisma.syncState.update).not.toHaveBeenCalled();
  });
});
