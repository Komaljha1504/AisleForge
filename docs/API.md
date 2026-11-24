# API reference

This reference was generated from the route definitions in `apps/api/src/routes/*.ts` and the permission table in
`packages/domain/src/identity/authorization.ts` (2026-11-23). Every request and response body is validated by the
zod schemas in `packages/validation/src/index.ts`, which are the authoritative field lists. Errors always use one
shape: `{ "error": { "code", "message", "details"? }, "requestId" }`. `details` appears only on 4xx responses, for
example validation issues.

## Conventions

- **Authentication**:
  - every `/api/v1/*` route except `/auth/*` needs `Authorization: Bearer <access token>` (JWT, 10-minute lifetime);
  - the refresh token is an HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/v1/auth` (ADR-005).
- **CSRF**: `/auth/refresh` and `/auth/logout` need the `X-CSRF-Protection: 1` header and an allowed `Origin`.
- **Store isolation**: pickers and supervisors only see their own store; admins are global; customers see only their
  own orders.
- **Idempotency**: `POST /orders` requires an `Idempotency-Key` header. Keys are scoped to the principal, and a replay
  returns the original response.
- **Correlation**: `X-Request-Id` is returned on every response and is propagated through the outbox, Kafka and the
  worker.
- **Overload**:
  - `503 DB_POOL_EXHAUSTED` is returned fast when no database connection is free within the acquire timeout;
  - `429` with `Retry-After` on rate limits, and on `/sync` load shedding.

## Permissions by role

| Permission                        | customer | picker | supervisor | admin |
| --------------------------------- | -------- | ------ | ---------- | ----- |
| `orders:place`                    | ✓        |        |            |       |
| `orders:read` (scoped)            | ✓        | ✓      | ✓          | ✓     |
| `orders:cancel`                   | ✓        |        | ✓          | ✓     |
| `catalog:read`                    | ✓        | ✓      | ✓          | ✓     |
| `inventory:read`                  |          | ✓      | ✓          | ✓     |
| `inventory:write`                 |          |        | ✓          | ✓     |
| `tasks:read`                      |          | ✓      | ✓          | ✓     |
| `tasks:pick`, `sync:write`        |          | ✓      | ✓          |       |
| `rejections:review`               |          |        | ✓          | ✓     |
| `users:manage`, `internal:status` |          |        |            | ✓     |

## Endpoints

| Method      | Path                                                                      | Permission          | Purpose                                                                                                                    |
| ----------- | ------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/health/live`                                                            | public              | process liveness (never checks dependencies)                                                                               |
| GET         | `/health/ready`                                                           | public              | readiness: PostgreSQL reachable within 1 s and not draining (`503 draining` / `503 not_ready`)                             |
| POST        | `/api/v1/auth/register`                                                   | public              | customer self-registration (password policy, Argon2id)                                                                     |
| POST        | `/api/v1/auth/login`                                                      | public              | login → access token + refresh cookie (per-IP limit, lockout-abuse-resistant throttle)                                     |
| POST        | `/api/v1/auth/refresh`                                                    | cookie + CSRF       | rotate the refresh token; reuse of an old one revokes the whole family                                                     |
| POST        | `/api/v1/auth/logout`                                                     | cookie + CSRF       | revoke the session                                                                                                         |
| GET / PATCH | `/api/v1/me`                                                              | authenticated       | own profile (no mass assignment)                                                                                           |
| POST        | `/api/v1/orders`                                                          | `orders:place`      | place an order: guarded stock reservation + ledger + outbox in one transaction                                             |
| GET         | `/api/v1/orders`, `/api/v1/orders/:id`                                    | `orders:read`       | list (cursor-paginated) / read, scoped                                                                                     |
| POST        | `/api/v1/orders/:id/cancel`                                               | `orders:cancel`     | cancel and release the reserved stock                                                                                      |
| GET         | `/api/v1/stores`                                                          | `catalog:read`      | stores                                                                                                                     |
| GET         | `/api/v1/stores/:storeId/catalog`                                         | `catalog:read`      | display-only availability (`limit` ≤ 500, `offset`); `X-Cache: HIT/MISS/DISABLED`                                          |
| GET         | `/api/v1/stores/:storeId/inventory`                                       | `inventory:read`    | balances for the store                                                                                                     |
| GET         | `/api/v1/stores/:storeId/inventory/:sku`                                  | `inventory:read`    | one balance                                                                                                                |
| POST        | `/api/v1/stores/:storeId/inventory/:sku/restocks`                         | `inventory:write`   | restock (idempotent per source id)                                                                                         |
| POST        | `/api/v1/stores/:storeId/inventory/:sku/adjustments`                      | `inventory:write`   | stock adjustment with a reason                                                                                             |
| GET         | `/api/v1/pick-tasks?scope=available\|mine\|active\|all&limit≤200`         | `tasks:read`        | task list (`available`: FIFO; `all`: newest first)                                                                         |
| GET         | `/api/v1/pick-tasks/:id`                                                  | `tasks:read`        | a task with its lines and planned route                                                                                    |
| POST        | `/api/v1/pick-tasks/:id/claim`                                            | `tasks:pick`        | claim with a lease (online only); extends the order's reservations                                                         |
| POST        | `/api/v1/pick-tasks/:id/release`                                          | `tasks:read`        | release a claimed task                                                                                                     |
| POST        | `/api/v1/sync`                                                            | `sync:write`        | upload offline operations (device id, op ids, per-device sequence); per op: `applied` / `duplicate` / `rejected` / `retry` |
| GET         | `/api/v1/sync/rejections/mine`                                            | `sync:write`        | the caller's rejected operations                                                                                           |
| GET         | `/api/v1/sync/rejections`                                                 | `rejections:review` | store rejections for supervisor review                                                                                     |
| POST        | `/api/v1/sync/rejections/:deviceId/:opId/resolve`                         | `rejections:review` | acknowledge, or request a recount                                                                                          |
| GET / POST  | `/api/v1/admin/users`                                                     | `users:manage`      | list / create staff accounts                                                                                               |
| PATCH       | `/api/v1/admin/users/:id/role`                                            | `users:manage`      | change role (revokes sessions)                                                                                             |
| POST        | `/api/v1/admin/users/:id/unlock-login`                                    | `users:manage`      | clear login-throttle state (audited)                                                                                       |
| GET         | `/internal/status`                                                        | `internal:status`   | pools, transactions, outbox backlog, worker snapshots (Kafka lag, producer), Redis                                         |
| GET         | `/internal/dead-letters`, `/internal/dead-letters/:id`                    | `internal:status`   | inspect dead letters                                                                                                       |
| POST        | `/internal/dead-letters/:id/replay`, `/internal/dead-letters/:id/discard` | `internal:status`   | replay (executed by the worker) / discard with a note, both audited                                                        |

## Events (Kafka)

Topics, envelope, keys and the consumer contract are in `docs/architecture/KAFKA_EVENT_PROCESSING.md`. The offline
sync protocol is ADR-004.
