import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { MoviesService } from './movies.service';
import type { TmdbMovieDetails } from '../tmdb/tmdb.types';

const describeIfDb =
  process.env.INTEGRATION_DB === '1' ? describe : describe.skip;

describeIfDb('MoviesService (integration)', () => {
  let prisma: PrismaService;
  let service: MoviesService;

  const fixture: TmdbMovieDetails = {
    id: 999_001,
    title: 'Test Movie',
    overview: 'idempotency fixture',
    release_date: '2024-01-15',
    popularity: 12.34,
    vote_average: 7.5,
    vote_count: 100,
    runtime: 120,
    adult: false,
    genres: [
      { id: 28, name: 'Action' },
      { id: 12, name: 'Adventure' },
    ],
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new MoviesService(prisma, new MetricsService());
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(cleanup);

  async function cleanup() {
    await prisma.movieGenre.deleteMany({ where: { movieId: fixture.id } });
    await prisma.movie.deleteMany({ where: { id: fixture.id } });
    await prisma.genre.deleteMany({ where: { id: { in: [28, 12] } } });
  }

  it('upsertFromTmdb is idempotent — повторный вызов не плодит дубликаты', async () => {
    await service.upsertFromTmdb(fixture, new Date());
    await service.upsertFromTmdb(fixture, new Date());

    const movies = await prisma.movie.findMany({ where: { id: fixture.id } });
    const links = await prisma.movieGenre.findMany({
      where: { movieId: fixture.id },
    });

    expect(movies).toHaveLength(1);
    expect(links).toHaveLength(2);
  });

  it('softDelete → upsert un-deletes: цикл удалён/вернулся в TMDB', async () => {
    await service.upsertFromTmdb(fixture, new Date());
    await service.softDelete(fixture.id);

    const deleted = await prisma.movie.findUniqueOrThrow({
      where: { id: fixture.id },
    });
    expect(deleted.deletedAt).not.toBeNull();

    await service.upsertFromTmdb(fixture, new Date());
    const restored = await prisma.movie.findUniqueOrThrow({
      where: { id: fixture.id },
    });
    expect(restored.deletedAt).toBeNull();
  });
});
