import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { ListMoviesQueryDto } from './dto/list-movies.query';

type MovieWithGenres = {
  id: number;
  title: string;
  originalTitle: string | null;
  overview: string | null;
  releaseDate: Date | null;
  popularity: number;
  voteAverage: number;
  voteCount: number;
  runtime: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  originalLanguage: string | null;
  adult: boolean;
  status: string | null;
  syncedAt: Date;
  lastChangeObservedAt: Date | null;
  genres: { genre: { id: number; name: string } }[];
};

@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  @Get()
  async list(@Query() query: ListMoviesQueryDto) {
    const { items, total, page, pageSize } = await this.movies.list(query);
    return {
      data: items.map(serializeMovie),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return serializeMovie(await this.movies.findOne(id));
  }
}

function serializeMovie(m: MovieWithGenres) {
  return {
    id: m.id,
    title: m.title,
    original_title: m.originalTitle,
    overview: m.overview,
    release_date: m.releaseDate?.toISOString().slice(0, 10) ?? null,
    popularity: m.popularity,
    vote_average: m.voteAverage,
    vote_count: m.voteCount,
    runtime: m.runtime,
    poster_path: m.posterPath,
    backdrop_path: m.backdropPath,
    original_language: m.originalLanguage,
    adult: m.adult,
    status: m.status,
    genres: m.genres.map((g) => g.genre),
    synced_at: m.syncedAt.toISOString(),
    last_change_observed_at: m.lastChangeObservedAt?.toISOString() ?? null,
  };
}
