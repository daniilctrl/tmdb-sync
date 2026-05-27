import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export type MovieSortField =
  | 'popularity'
  | 'vote_average'
  | 'release_date'
  | 'title';
export type SortOrder = 'asc' | 'desc';

export class ListMoviesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  @Max(2100)
  year?: number;

  /** TMDB genre id */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  genreId?: number;

  @IsOptional()
  @IsEnum(['popularity', 'vote_average', 'release_date', 'title'])
  sort?: MovieSortField;

  @IsOptional()
  @IsEnum(['asc', 'desc'])
  order?: SortOrder;
}
