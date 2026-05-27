# tmdb-sync

Сервис синхронизирует каталог фильмов TMDB → локальный Postgres. Синк
инкрементальный: повторные запуски тянут только изменения через `/movie/changes`.

Стек: Node 20, NestJS 11 (Fastify), Prisma + Postgres, BullMQ + Redis.

## Запуск

```bash
cp .env.example .env             # вписать TMDB_API_KEY
docker compose up -d             # Postgres + Redis
npm install
npx prisma migrate deploy
npm run start
```

- API: <http://localhost:3000>
- `GET /movies?year=&genreId=&sort=&order=&page=&pageSize=` — список с фильтрами/пагинацией
- `GET /movies/:id` — детали (404 если soft-deleted)
- `GET /sync/status` — состояние последней синхронизации
- `GET /health`, `GET /metrics`

## Схема БД

```
movies                            id = TMDB id (PK)
  title, overview, release_date, popularity, vote_average, ...
  last_change_observed_at         верх окна /changes, в котором всплыл id
  synced_at                       @updatedAt
  deleted_at                      soft delete

genres        (id, name)
movie_genres  (movie_id, genre_id) — N:N

sync_state    singleton id=1
  last_change_cursor              курсор инкрементального синка
  bootstrap_completed_at

sync_runs                         журнал каждого запуска
  kind, status, cursor_from/to, started/finished_at, counters, error_message
```

Индексы: `release_date`, `popularity desc`, `vote_average desc`, `deleted_at`,
`movie_genres(genre_id)`, `sync_runs(started_at desc, status)`.

## Логика синхронизации

```
@Cron('*/15 * * * *') → BullMQ.add('sync', { jobId: 'incremental-sync' })  ← дедуп
                                                              │
SyncChangesProcessor          concurrency: 1                  ▼
  while (window = sync.openWindow()) {            чанки ≤7 дней
    run = sync.startRun(window)
    ids = tmdb.fetchChangedIds(window)            GET /movie/changes
    detailsQueue.addBulk(ids, jobId=`movie:${id}`) ← дедуп
    sync.commitWindow(run.id, window)             tx: SyncRun + SyncState
  }
                                                              │
MovieDetailsProcessor     concurrency: 10                     ▼
                          limiter: 40 req/sec
  tmdb.fetchMovie(id) → movies.upsertFromTmdb(details)
  on 404      → softDelete(id)
  on 429/5xx  → throw → BullMQ retry (5 attempts, exp backoff)
```

## Почему так

- **`movies.id = TMDB id` (не autoincrement)** - upsert идемпотентен из коробки
  (`ON CONFLICT (id) DO UPDATE`), без поиска по external_id, без гонок.

- **Окна `/movie/changes` чанкуются по 7 дней** — TMDB ограничивает окно 14
  днями. После каждого чанка курсор двигается атомарно с записью `sync_runs`
  (одна транзакция). Падение на чанке #3 → следующий запуск стартует с #3,
  идемпотентность upsert-ов делает повтор безопасным.

- **Rate limit на BullMQ-воркере, а не в TmdbClient** — лимитер в клиенте
  при N инстансах приложения умножается на N. На воркере лимит работает
  через Redis глобально для всех инстансов.

- **Concurrent-защита через BullMQ**: `jobId='incremental-sync'` + `removeOnComplete`
  не даёт двум pending-job-ам с таким id, `concurrency: 1` + Redis-lock не
  даёт двум воркерам обработать один job одновременно. Advisory lock в
  Postgres был бы дублирующей шкалой.

- **Soft delete** на 404 от TMDB; при возврате фильма `upsertFromTmdb`
  ставит `deletedAt = null`.

- **`last_change_observed_at` вместо `tmdb_updated_at`** — TMDB не отдаёт
  `updated_at`. Храним верхнюю границу окна `/changes`, в котором всплыл id.

## Тесты

```bash
npm test
INTEGRATION_DB=1 npm test
```

Покрыта ключевая логика синки: retry 429 / 404 без retry в TmdbClient,
чанкирование окна и атомарность чекпоинта в SyncService, идемпотентность
upsert и soft-delete-цикл (integration против реального Postgres).
