import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import type { Env } from '../config/env.schema';
import type {
  ChangesWindow,
  TmdbChangesResponse,
  TmdbGenreListResponse,
  TmdbMovieDetails,
  TmdbPaginatedResponse,
  TmdbPopularMovie,
} from './tmdb.types';

const MAX_CHANGES_WINDOW_DAYS = 14;
const MAX_RETRIES = 3;

@Injectable()
export class TmdbClient {
  private readonly logger = new Logger(TmdbClient.name);
  private readonly http: AxiosInstance;

  constructor(config: ConfigService<Env, true>) {
    this.http = axios.create({
      baseURL: config.get('TMDB_BASE_URL', { infer: true }),
      timeout: 15_000,
      params: { api_key: config.get('TMDB_API_KEY', { infer: true }) },
    });
  }

  fetchGenres(): Promise<TmdbGenreListResponse> {
    return this.request('GET', '/genre/movie/list');
  }

  fetchPopular(page: number): Promise<TmdbPaginatedResponse<TmdbPopularMovie>> {
    return this.request('GET', '/movie/popular', { page });
  }

  fetchMovie(id: number): Promise<TmdbMovieDetails> {
    return this.request('GET', `/movie/${id}`);
  }

  async fetchChangedIds(window: ChangesWindow): Promise<number[]> {
    const spanDays = (window.to.getTime() - window.from.getTime()) / 86_400_000;
    if (spanDays > MAX_CHANGES_WINDOW_DAYS) {
      throw new Error(
        `TMDB /movie/changes window exceeds ${MAX_CHANGES_WINDOW_DAYS} days (${Math.round(spanDays)}d). Caller must chunk windows.`,
      );
    }

    const startDate = window.from.toISOString().slice(0, 10);
    const endDate = window.to.toISOString().slice(0, 10);

    const ids = new Set<number>();
    let page = 1;
    let totalPages = 1;

    do {
      const res = await this.request<TmdbChangesResponse>(
        'GET',
        '/movie/changes',
        {
          start_date: startDate,
          end_date: endDate,
          page,
        },
      );
      for (const item of res.results) ids.add(item.id);
      totalPages = res.total_pages;
      page += 1;
    } while (page <= totalPages);

    return [...ids];
  }

  private async request<T>(
    method: 'GET',
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= MAX_RETRIES) {
      try {
        const res = await this.http.request<T>({ method, url: path, params });
        return res.data;
      } catch (err) {
        lastError = err;
        const ax = err as AxiosError;
        const status = ax.response?.status;

        if (status === 404) {
          throw new HttpException(`TMDB ${path} not found`, 404);
        }

        const isRetriable =
          status === 429 || (status !== undefined && status >= 500);
        if (!isRetriable) {
          throw new HttpException(
            `TMDB ${path} failed: ${ax.message}`,
            status ?? 500,
          );
        }

        if (attempt === MAX_RETRIES) break;

        const retryAfter = Number(ax.response?.headers?.['retry-after']);
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 500;
        this.logger.warn(
          `TMDB ${path} status=${status}, retry in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        attempt += 1;
      }
    }

    const ax = lastError as AxiosError;
    throw new HttpException(
      `TMDB ${path} failed after ${MAX_RETRIES} retries: ${ax.message}`,
      ax.response?.status ?? 500,
    );
  }
}
