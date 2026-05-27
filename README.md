# tmdb-sync

Сервис синхронизирует каталог фильмов TMDB в локальный Postgres и отдаёт его
через REST. Синхронизация инкрементальная: повторные запуски тянут только
изменения через TMDB `/movie/changes`.

Стек: Node.js 20, NestJS 11 на Fastify, Prisma, Postgres 16, BullMQ, Redis 7.

## Запуск

```bash
cp .env.example .env
# вписать TMDB_API_KEY
docker compose up -d
npm install
npx prisma migrate deploy
npm run start
```

API будет доступен на http://localhost:3000.

## REST API

| Метод | Путь            | Что делает                                  |
|-------|-----------------|---------------------------------------------|
| GET   | /movies         | Список с пагинацией и фильтрами             |
| GET   | /movies/:id     | Детали фильма. 404, если soft-deleted       |
| GET   | /sync/status    | Состояние последней синхронизации           |
| GET   | /health         | Готовность Postgres и Redis                 |
| GET   | /metrics        | Метрики в формате Prometheus                |

Параметры запроса `/movies`:

| Параметр  | Тип и допустимые значения                         | По умолчанию |
|-----------|---------------------------------------------------|--------------|
| page      | целое, >= 1                                       | 1            |
| pageSize  | целое, 1..100                                     | 20           |
| year      | целое, 1800..2100                                 | без фильтра  |
| genreId   | целое, id жанра по справочнику TMDB               | без фильтра  |
| sort      | popularity, vote_average, release_date, title     | popularity   |
| order     | asc, desc                                         | desc         |

Ответ списка содержит `data` и `pagination` с полями `page`, `pageSize`,
`total`, `totalPages`.

## Конфигурация

Всё берётся из `.env`, шаблон в `.env.example`.

| Переменная               | Назначение                                                     |
|--------------------------|----------------------------------------------------------------|
| TMDB_API_KEY             | Ключ TMDB v3                                                   |
| TMDB_BASE_URL            | Базовый URL TMDB API                                           |
| TMDB_RATE_LIMIT_PER_SEC  | Глобальный лимит воркера деталей. По умолчанию 40              |
| SYNC_INTERVAL_MINUTES    | Период инкрементального синка. По умолчанию 15                 |
| BOOTSTRAP_POPULAR_PAGES  | Сколько страниц `/movie/popular` тянуть при первом старте      |
| SYNC_JOB_ATTEMPTS        | Сколько раз BullMQ ретраит упавший job деталей. По умолчанию 5 |
| DATABASE_URL             | Строка подключения к Postgres                                  |
| REDIS_HOST, REDIS_PORT   | Подключение к Redis                                            |
| PORT, LOG_LEVEL, NODE_ENV| Общие настройки приложения                                     |

## Схема БД

```
movies
  id                       PK, совпадает с TMDB id
  title, original_title, overview
  release_date, runtime, popularity, vote_average, vote_count
  poster_path, backdrop_path, original_language, adult, status
  last_change_observed_at  верхняя граница окна /changes, в котором всплыл id
  synced_at                @updatedAt
  deleted_at               soft delete

genres        id, name
movie_genres  movie_id, genre_id   N:N

sync_state                синглтон id = 1
  last_change_cursor      курсор инкрементального синка
  bootstrap_completed_at

sync_runs                 журнал каждого запуска
  kind, status
  started_at, finished_at
  cursor_from, cursor_to
  ids_enqueued            сколько id ушло в очередь деталей
  movies_upserted         сколько фактически записалось
  movies_failed           сколько упало после всех ретраев
  error_message           если status = 'error'
```

Индексы: `movies.release_date`, `movies.popularity desc`,
`movies.vote_average desc`, `movies.deleted_at`,
`movie_genres.genre_id`, `sync_runs.started_at desc`, `sync_runs.status`.

## Логика синхронизации

### Bootstrap

Запускается один раз при первом старте, пока `sync_state.bootstrap_completed_at`
ещё `NULL`.

1. Загружает справочник жанров из `/genre/movie/list`.
2. Тянет первые `BOOTSTRAP_POPULAR_PAGES` страниц `/movie/popular`
   и делает upsert каждого фильма.
3. Отправляет id всех загруженных фильмов в очередь деталей. Тот же воркер,
   что обрабатывает инкрементальный синк, добирает по ним полные данные:
   runtime, статус, полный список жанров.
4. Помечает `bootstrap_completed_at = now()` и
   `last_change_cursor = now()`.

Третий шаг нужен потому, что `/movie/popular` отдаёт обрезанную проекцию
без runtime и без полного списка жанров.

### Инкрементальный синк

Запускается по cron через `SchedulerRegistry` раз в `SYNC_INTERVAL_MINUTES`
минут.

1. Cron-callback кладёт в очередь `sync` job с фиксированным
   `jobId='incremental-sync'`. Повторный job с тем же id не встанет
   в очередь, пока предыдущий не завершён.
2. `SyncChangesProcessor` с concurrency = 1 берёт job и в цикле обрабатывает
   окна `[last_change_cursor, now]`. TMDB ограничивает окно 14 днями,
   поэтому окно режется на чанки по 7 дней.
3. Для каждого чанка:
   - вызов `/movie/changes` отдаёт список изменённых id, с пагинацией;
   - id уходят в очередь деталей по одному job на каждый id,
     `jobId='movie:${id}'` дедуплицирует параллельные обновления;
   - одной транзакцией: `sync_runs.status = success`,
     `ids_enqueued = N`, `last_change_cursor = window.to`;
   - переход к следующему чанку.
4. `MovieDetailsProcessor` с concurrency = 10 и Redis-лимитером
   40 req/sec тянет `/movie/{id}` и делает upsert. На 404 ставит soft-delete.
   На 429 и 5xx бросает ошибку, BullMQ ретраит с экспоненциальным backoff,
   до `SYNC_JOB_ATTEMPTS` попыток.
5. Каждый завершённый job деталей через `OnWorkerEvent('completed' | 'failed')`
   инкрементирует `sync_runs.movies_upserted` или `movies_failed`. Эти
   счётчики могут продолжать расти после того, как run помечен `success`:
   их сумма сходится к `ids_enqueued` по мере драина очереди.

### Поведение при сбоях

- Падение посреди чанков. Курсор сдвинут только до последнего успешного
  чанка, следующий запуск продолжит с того же места.
- Падение на одном job деталей. Ретраится самим BullMQ, не влияет на курсор
  и не блокирует обработку других id.
- Падение всего процессора. `SyncRun` пишется со статусом `error`
  и `error_message`, курсор не сдвигается, следующий cron-тик повторит окно.

## Решения по проектированию

`movies.id` равен TMDB id, а не автоинкременту. Upsert идемпотентен без
поиска по external_id, повторный синк тех же данных безопасен.

Окно `/changes` режется на чанки по 7 дней потому, что TMDB ограничивает
запрос 14 днями. После каждого чанка курсор и `sync_run` обновляются в
одной транзакции, поэтому падение на чанке N не теряет работу первых N-1.

Rate limit стоит на BullMQ-воркере, а не в HTTP-клиенте. Лимитер в клиенте
при нескольких инстансах приложения умножился бы на число инстансов.
Лимитер в BullMQ работает через Redis глобально на все инстансы.

Дедуп идёт через `jobId` BullMQ, без advisory lock в Postgres.
`jobId='incremental-sync'` плюс `removeOnComplete` не дают встать в очередь
второму job с тем же id. `concurrency: 1` плюс Redis-lock не дают двум
воркерам забрать один job одновременно. Дополнительный advisory lock был бы
дублирующей защитой.

Soft-delete срабатывает на 404 от TMDB. При возврате фильма в каталог
`upsertFromTmdb` ставит `deletedAt = null`, поэтому ресуррект тоже
идемпотентен.

`last_change_observed_at` хранится вместо `tmdb_updated_at` потому, что
TMDB не отдаёт `updated_at` в `/movie/{id}`. Поле хранит верхнюю границу
окна `/changes`, в котором id был замечен, и нужно для аудита.

## Тесты

```bash
npm test                       # unit
INTEGRATION_DB=1 npm test      # плюс интеграционные против локального Postgres
```

Покрыты ключевые места:
- `TmdbClient`: retry на 429 и 5xx, отсутствие retry на 404.
- `SyncService`: чанкирование окна, атомарность чекпоинта.
- `MoviesService`: идемпотентность upsert и soft-delete-цикл, реальный Postgres.
