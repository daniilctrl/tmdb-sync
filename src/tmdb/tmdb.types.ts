export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbGenreListResponse {
  genres: TmdbGenre[];
}

export interface TmdbPaginatedResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface TmdbPopularMovie {
  id: number;
  title: string;
  original_title?: string;
  overview?: string;
  release_date?: string;
  popularity: number;
  vote_average: number;
  vote_count: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  adult?: boolean;
  genre_ids?: number[];
}

export interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title?: string;
  overview?: string;
  release_date?: string;
  popularity: number;
  vote_average: number;
  vote_count: number;
  runtime?: number | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  adult?: boolean;
  status?: string;
  genres?: TmdbGenre[];
}

export interface TmdbChangedMovie {
  id: number;
  adult: boolean | null;
}

export interface TmdbChangesResponse {
  results: TmdbChangedMovie[];
  page: number;
  total_pages: number;
  total_results: number;
}

export interface ChangesWindow {
  from: Date;
  to: Date;
}
