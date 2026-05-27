/* eslint-disable @typescript-eslint/no-unsafe-call */
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { TmdbClient } from './tmdb.client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function buildClient(): TmdbClient {
  const config = {
    get: (key: string) =>
      ({
        TMDB_BASE_URL: 'https://api.tmdb.test/3',
        TMDB_API_KEY: 'test-key',
      })[key],
  } as unknown as ConfigService<never, true>;
  return new TmdbClient(config);
}

function axiosError(
  status: number,
  headers: Record<string, string> = {},
): AxiosError {
  const err = new Error(`HTTP ${status}`) as AxiosError;
  err.isAxiosError = true;
  err.response = {
    status,
    statusText: '',
    headers: new AxiosHeaders(headers),
    config: {} as never,
    data: undefined,
  };
  return err;
}

describe('TmdbClient', () => {
  let client: TmdbClient;
  let requestSpy: jest.Mock;

  beforeEach(() => {
    requestSpy = jest.fn();
    mockedAxios.create.mockReturnValue({ request: requestSpy } as never);
    client = buildClient();
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: TimerHandler) => {
      if (typeof cb === 'function') cb();
      return 0 as unknown as NodeJS.Timeout;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('retries on 429 respecting Retry-After', async () => {
    requestSpy
      .mockRejectedValueOnce(axiosError(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce({ data: { id: 1, title: 'OK' } });

    const result = await client.fetchMovie(1);
    expect(result.title).toBe('OK');
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 404', async () => {
    requestSpy.mockRejectedValue(axiosError(404));

    await expect(client.fetchMovie(999)).rejects.toMatchObject({ status: 404 });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
