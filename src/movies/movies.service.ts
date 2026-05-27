import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Movie, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import type {
  TmdbGenre,
  TmdbMovieDetails,
  TmdbPopularMovie,
} from '../tmdb/tmdb.types';
import type {
  ListMoviesQueryDto,
  MovieSortField,
} from './dto/list-movies.query';

const SORT_FIELD_MAP: Record<
  MovieSortField,
  keyof Prisma.MovieOrderByWithRelationInput
> = {
  popularity: 'popularity',
  vote_average: 'voteAverage',
  release_date: 'releaseDate',
  title: 'title',
};

@Injectable()
export class MoviesService {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async upsertFromTmdb(
    details: TmdbMovieDetails,
    observedAt: Date | null,
  ): Promise<Movie> {
    const movieData = mapTmdbDetailsToMovie(details, observedAt);
    const genres = details.genres ?? [];

    const result = await this.prisma.$transaction(async (tx) => {
      for (const g of genres) {
        await tx.genre.upsert({
          where: { id: g.id },
          create: { id: g.id, name: g.name },
          update: { name: g.name },
        });
      }

      const movie = await tx.movie.upsert({
        where: { id: details.id },
        create: movieData,
        update: movieData,
      });

      await tx.movieGenre.deleteMany({ where: { movieId: details.id } });
      if (genres.length) {
        await tx.movieGenre.createMany({
          data: genres.map((g) => ({ movieId: details.id, genreId: g.id })),
          skipDuplicates: true,
        });
      }

      return movie;
    });
    this.metrics.moviesUpserted.inc({ source: 'changes' });
    return result;
  }

  async upsertFromPopular(
    movie: TmdbPopularMovie,
    knownGenreIds: Set<number>,
  ): Promise<Movie> {
    const data = mapTmdbPopularToMovie(movie);
    const genreIds = (movie.genre_ids ?? []).filter((id) =>
      knownGenreIds.has(id),
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const m = await tx.movie.upsert({
        where: { id: movie.id },
        create: data,
        update: data,
      });

      await tx.movieGenre.deleteMany({ where: { movieId: movie.id } });
      if (genreIds.length) {
        await tx.movieGenre.createMany({
          data: genreIds.map((gid) => ({ movieId: movie.id, genreId: gid })),
          skipDuplicates: true,
        });
      }

      return m;
    });
    this.metrics.moviesUpserted.inc({ source: 'popular' });
    return result;
  }

  async upsertGenres(genres: TmdbGenre[]): Promise<void> {
    await this.prisma.$transaction(
      genres.map((g) =>
        this.prisma.genre.upsert({
          where: { id: g.id },
          create: { id: g.id, name: g.name },
          update: { name: g.name },
        }),
      ),
    );
  }

  async softDelete(id: number): Promise<void> {
    const res = await this.prisma.movie.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count > 0) {
      this.metrics.moviesSoftDeleted.inc();
      this.logger.warn(`Soft-deleted movie ${id} (TMDB returned 404)`);
    }
  }

  async list(query: ListMoviesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.MovieWhereInput = { deletedAt: null };
    if (query.year !== undefined) {
      where.releaseDate = {
        gte: new Date(Date.UTC(query.year, 0, 1)),
        lt: new Date(Date.UTC(query.year + 1, 0, 1)),
      };
    }
    if (query.genreId !== undefined) {
      where.genres = { some: { genreId: query.genreId } };
    }

    const orderBy: Prisma.MovieOrderByWithRelationInput = {
      [SORT_FIELD_MAP[query.sort ?? 'popularity']]: query.order ?? 'desc',
    };

    const [items, total] = await Promise.all([
      this.prisma.movie.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { genres: { include: { genre: true } } },
      }),
      this.prisma.movie.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async findOne(id: number) {
    const movie = await this.prisma.movie.findFirst({
      where: { id, deletedAt: null },
      include: { genres: { include: { genre: true } } },
    });
    if (!movie) throw new NotFoundException(`Movie ${id} not found`);
    return movie;
  }
}

function parseReleaseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1800 ? null : d;
}

function mapTmdbDetailsToMovie(
  details: TmdbMovieDetails,
  observedAt: Date | null,
): Prisma.MovieUncheckedCreateInput {
  return {
    id: details.id,
    title: details.title,
    originalTitle: details.original_title ?? null,
    overview: details.overview ?? null,
    releaseDate: parseReleaseDate(details.release_date),
    popularity: details.popularity ?? 0,
    voteAverage: details.vote_average ?? 0,
    voteCount: details.vote_count ?? 0,
    runtime: details.runtime ?? null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
    originalLanguage: details.original_language ?? null,
    adult: details.adult ?? false,
    status: details.status ?? null,
    lastChangeObservedAt: observedAt,
    deletedAt: null,
  };
}

function mapTmdbPopularToMovie(
  m: TmdbPopularMovie,
): Prisma.MovieUncheckedCreateInput {
  return {
    id: m.id,
    title: m.title,
    originalTitle: m.original_title ?? null,
    overview: m.overview ?? null,
    releaseDate: parseReleaseDate(m.release_date),
    popularity: m.popularity ?? 0,
    voteAverage: m.vote_average ?? 0,
    voteCount: m.vote_count ?? 0,
    posterPath: m.poster_path ?? null,
    backdropPath: m.backdrop_path ?? null,
    originalLanguage: m.original_language ?? null,
    adult: m.adult ?? false,
    deletedAt: null,
  };
}
