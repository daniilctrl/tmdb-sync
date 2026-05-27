# tmdb-sync

Сервис синхронизирует каталог фильмов TMDB в локальный Postgres и отдаёт его
через REST. Синхронизация инкрементальная: повторные запуски тянут только
изменения через TMDB `/movie/changes`.

Стек: Node.js 20, NestJS 11, Prisma, Postgres 16, BullMQ, Redis 7.

## Запуск

```bash
cp .env.example .env             # вписать TMDB_API_KEY
docker compose up -d
npm install
npx prisma migrate deploy
npm run start
```

API на http://localhost:3000.

- `GET /movies?page=&pageSize=&year=&genreId=&sort=&order=`
  сортировка по `popularity`, `vote_average`, `release_date`, `title`.
- `GET /movies/:id`: детали, 404 если soft-deleted.
- `GET /sync/status`: состояние последней синхронизации.
- `GET /health`, `GET /metrics`.

Настройки приложения берутся из `.env`, ключевые:
`TMDB_API_KEY`, `SYNC_INTERVAL_MINUTES`, `BOOTSTRAP_POPULAR_PAGES`,
`TMDB_RATE_LIMIT_PER_SEC`, `SYNC_JOB_ATTEMPTS`. Полный список с дефолтами
в `.env.example`.

## Схема БД

```
movies                    id = TMDB id (PK)
  title, overview, release_date, runtime, popularity, vote_average, vote_count,
  poster_path, backdrop_path, original_language, adult, status
  last_change_observed_at верх окна /changes, в котором всплыл id
  synced_at               @updatedAt
  deleted_at              soft delete

genres        id, name
movie_genres  movie_id, genre_id    N:N

sync_state                синглтон id = 1
  last_change_cursor      курсор инкрементального синка
  bootstrap_completed_at

sync_runs                 журнал каждого запуска
  kind, status, started_at, finished_at, cursor_from, cursor_to
  ids_enqueued            сколько id ушло в очередь деталей
  movies_upserted         сколько фактически записалось
  movies_failed           сколько упало после всех ретраев
  error_message           если status = 'error'
```

Индексы: `movies.release_date`, `movies.popularity desc`,
`movies.vote_average desc`, `movies.deleted_at`,
`movie_genres.genre_id`, `sync_runs.started_at desc`, `sync_runs.status`.

## Логика синхронизации

**Bootstrap** запускается один раз, пока `bootstrap_completed_at IS NULL`:
загружает справочник жанров, тянет `BOOTSTRAP_POPULAR_PAGES` страниц
`/movie/popular`, дальше отправляет id всех фильмов в очередь деталей,
чтобы добрать поля, которых нет в `/popular`: runtime, статус, полный
список жанров. После этого ставит `bootstrap_completed_at = now()` и
`last_change_cursor = now()`.

**Инкрементальный синк** запускается по cron раз в `SYNC_INTERVAL_MINUTES`
минут через `SchedulerRegistry`:

1. Cron-callback кладёт в очередь job с `jobId='incremental-sync'`.
   Повторный job с тем же id не встанет в очередь, пока предыдущий
   не завершён.
2. `SyncChangesProcessor` с concurrency = 1 берёт job и режет окно
   `[last_change_cursor, now]` на чанки по 7 дней. Для каждого чанка:
   тянет id из `/movie/changes`, кладёт по одному job в очередь деталей
   `jobId='movie:${id}'`, и одной транзакцией пишет `sync_runs`
   и двигает курсор на `window.to`.
3. `MovieDetailsProcessor` с concurrency = 10 и Redis-лимитером
   40 req/sec тянет `/movie/{id}` и делает upsert. На 404 ставит
   soft-delete. На 429 и 5xx бросает ошибку, BullMQ ретраит с
   экспоненциальным backoff до `SYNC_JOB_ATTEMPTS` попыток.
4. Воркер деталей через `OnWorkerEvent('completed' | 'failed')`
   инкрементирует `movies_upserted` или `movies_failed` соответствующего
   run. Счётчики могут продолжать расти после `status = success`:
   их сумма сходится к `ids_enqueued` по мере драина очереди.

Падение посреди чанков не теряет работу: курсор сдвинут только до
последнего успешного чанка, следующий запуск стартует с него.
Падение одного job деталей ретраится BullMQ и не влияет на курсор.

## Почему так

- **`movies.id` равен TMDB id**, не автоинкремент. Upsert идемпотентен
  без поиска по external_id, повторный синк тех же данных безопасен.
- **Окно `/changes` режется на 7 дней**, потому что TMDB ограничивает
  запрос 14 днями. Курсор и `sync_run` обновляются в одной транзакции,
  поэтому падение на чанке N не теряет первые N-1.
- **Rate limit на BullMQ-воркере, а не в HTTP-клиенте.** Лимитер в
  клиенте при N инстансах приложения умножился бы на N. Лимитер
  BullMQ работает через Redis глобально.
- **Дедуп через `jobId` BullMQ.** `jobId='incremental-sync'` плюс
  `removeOnComplete` блокирует второй pending job. `concurrency: 1`
  плюс Redis-lock блокирует параллельную обработку одного job.
  Advisory lock в Postgres был бы дублирующей защитой.
- **`last_change_observed_at` вместо `tmdb_updated_at`** потому, что
  TMDB не отдаёт `updated_at` в `/movie/{id}`. Поле хранит верх окна
  `/changes`, в котором id был замечен.

## Тесты

```bash
npm test                       # unit
INTEGRATION_DB=1 npm test      # плюс интеграция против локального Postgres
```
