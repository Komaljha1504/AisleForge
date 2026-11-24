# ADR-007 — Redis: shared limits and a display-only catalog cache (never a source of truth)

**Status:** Accepted, implemented and tested (Phase 7, 2026-11-22). Evidence: `tests/kafka/r1-redis.test.ts`,
`audit/test-results/dev-evidence-2026-11-22/phase7/` (development runs; the official run is in `audit/test-results/phase10/`), and the Redis-off / Redis-on load comparison in `audit/test-results/phase6/runs/`
(`*-ab-redis-*`).

## Context

- Phase 6 baselines located the bottleneck under load in **API CPU and connection-pool queueing**, not in row
  locks. Redis must not be used to hide PostgreSQL contention, and it cannot fix CPU saturation of the API process.
- Phase 3 left a real security gap: rate limits and the login throttle were **per API instance**, so N replicas gave
  an attacker N times the attempt budget.

## Decision

Redis is optional. It is enabled by `REDIS_URL`, and every use has a bounded timeout and a fallback.

| Use                                                                                                 | Why it is justified                     | Design                                                                                                                           | Fallback when Redis is down                                                    |
| --------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Shared per-IP / per-user rate limits (login, register, sync)                                        | Multi-instance correctness (security)   | One Lua script per hit: `INCR` + `PEXPIRE` on first hit (atomic)                                                                 | In-process limiter (per-instance limits: degraded, never off)                  |
| Shared login throttle (per account+source locks, escalation, account-wide threshold, known sources) | Same, for brute force and lockout abuse | Same policy as the in-process throttle; each operation is one Lua script, so concurrent guesses cannot undercount                | In-process `LoginThrottle`                                                     |
| Catalog page cache (display-only availability)                                                      | Repeated identical reads while browsing | Cache-aside with a per-store **version** in the key, TTL 5 s, single-flight per key                                              | Read from PostgreSQL                                                           |
| Event-driven catalog invalidation                                                                   | Freshness after stock changes           | Worker consumer `catalog-cache` on `inventory.balance_changed`; at most one version bump per store per second (`SET NX PX 1000`) | Skipped; the cached page expires by TTL. Never fails or dead-letters the event |

**PostgreSQL remains the only authority for stock and reservations.** No Redis value is read on the placement
path. Test R1 proves it: the cache showed 5 available, PostgreSQL had 0, and the order was refused with 409.

Client settings (`packages/cache`):

- `commandTimeout` 150 ms;
- `enableOfflineQueue: false` (no request waits on a dead connection);
- `maxRetriesPerRequest: 0`;
- background reconnect.

Diagnostics: `/internal/status → redis` reports connected, ping, hits, misses, errors, fallbacks, invalidations and
the hit ratio. The worker reports the same in its snapshot.

Deployment:

- Redis has no persistence (`--save ''`), `maxmemory` 64 MB with `allkeys-lru`, and a 128 MiB container limit.
- Losing Redis costs cache warmth and in-flight throttle counters, never business data.

## Measured (test R1, real Redis, two API instances)

| Check                                                            | Result                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Per-IP login limit 6, attempts alternating between two instances | **7th attempt refused (429)**                                                                                          |
| Negative control: same, two instances without Redis              | **all 12 attempts allowed**: limits multiplied by the instance count                                                   |
| Source locked through instance A                                 | refused by instance B; another source of the same user is allowed; admin unlock clears it everywhere                   |
| Catalog                                                          | MISS, then HIT; after a restock (outbox → Kafka → `catalog-cache` consumer) the next read is a MISS with the new value |
| Cache stale vs database (5 shown, 0 in stock)                    | order **409 INSUFFICIENT_STOCK**                                                                                       |
| Outage: `docker compose stop redis`                              | logins 200 in 50–147 ms; catalog from PostgreSQL in 17 ms; 0 dead letters; `connected=false`, 19 fallbacks counted     |
| Recovery: `docker compose start redis`                           | cache used again after **1.7 s**                                                                                       |
| Invariants after the outage                                      | I1–I7 PASS                                                                                                             |

## Consequences

- During a Redis outage limits fall back to per-instance, and a fresh throttle state is used for that instance.
  This is documented as a degraded mode.
- Semantics differ slightly from the in-process throttle: fixed windows from the first failure instead of a
  sliding reset. The policy values are the same.
- The pre/post load comparison is reported in `docs/reports/PERFORMANCE_REPORT.md`, with the same workload
  (including catalog browsing) and Redis as the only variable.
