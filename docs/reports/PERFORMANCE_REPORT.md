# Performance report (Phase 6 / Phase 7)

All numbers were measured on 2026-11-22. The machine was Windows 11 with 7.7 GB RAM and 8 logical CPUs, running
Docker Desktop with the WSL2 VM capped at 4 GiB, and the full Docker Compose stack: PostgreSQL, Kafka, Redis, API ×1
(1 CPU, 384 MiB), worker ×1, and nginx. The load came from the k6 0.55 container on the Compose network
(`load-tests/k6/aisleforge.js`, orchestrated by `tools/load/run-profile.ts`). Raw evidence for every run:
`audit/test-results/phase6/runs/<run>/`, containing `k6-summary-*.json`, `server-samples.json` (5 s samples),
`run.json` and `summary.json`.

**What these numbers are not:**

- They are not production capacity figures. The API had one replica with one CPU, on a laptop shared with an IDE
  and browsers.
- Single-run latency on this machine varies a lot. T4 ranged 70.8–138.6 orders/s across 6 valid runs of the same
  code, so differences under about 2× are not attributed to code changes.

## Workload

These are the audit runbook profiles, keeping each profile's **arrival rate** but with the window **shortened to
3 minutes** (burst: 2 minutes) to fit the time and machine budget.

| Profile | Orders/min  | Pickers (VUs) | Stores | Products/store | Customers |
| ------- | ----------- | ------------- | ------ | -------------- | --------- |
| A       | 10          | 10            | 1      | 500            | 50        |
| B       | 67          | 50            | 2      | 5,000          | 200       |
| C       | 250         | 200           | 5      | 20,000         | 500       |
| D       | 500         | 500           | 10     | 50,000         | 1,000     |
| B burst | 670 (10× B) | 50            | 2      | 5,000          | 200       |

The workload in detail:

- Customers place 1–4-line orders, with 30 % of lines on the hottest 1 % of SKUs, and 2 % are deliberately resent
  with the same `Idempotency-Key`.
- Pickers claim real tasks and send each pick through `POST /sync` with human think time, then complete the task.
- A reconnect storm makes every picker upload queued picks at the same instant, mid-run.

## Results without Redis (baseline)

| Profile  | Orders created | Orders/s | Order p50 / p95 / p99  | Order errors | Sync p95 | Storm p95 | Max API CPU | Max PG CPU | Max orders-pool queue | Samples with lock waiters | Min host free RAM | I1–I7 |
| -------- | -------------- | -------- | ---------------------- | ------------ | -------- | --------- | ----------- | ---------- | --------------------- | ------------------------- | ----------------- | ----- |
| A        | 38             | 0.17     | 29 / 138 / 407 ms      | 0 %          | 122 ms   | n/a¹      | 55 %        | 51 %       | 0                     | 0 %                       | 496 MB            | PASS  |
| B        | 257            | 1.10     | 197 / 1,717 / 3,731 ms | 0 %          | 1.8 s    | 4.1 s     | 89 %        | 125 %      | 0                     | 27 %                      | 493 MB            | PASS  |
| C        | 729            | 2.59     | 2.0 / 6.8 / 23.4 s     | 5.9 %        | 6.0 s    | 6.2 s     | **99 %**    | 163 %      | **121**               | 33 %                      | 68 MB             | PASS  |
| D²       | 362            | 0.90     | 30.5 / 60.1 / 61.8 s   | 60 %         | 46.8 s   | 6.6 s     | 93 %        | 121 %      | 42                    | 0 %                       | **18 MB**         | PASS  |
| B burst² | 836            | 4.31     | 1.6 / 10.2 / 12.9 s    | 11.4 %       | 6.1 s    | 16.6 s    | 86 %        | 117 %      | 86                    | 13 %                      | **15 MB**         | PASS  |

1. Profile A has too few unclaimed tasks for the storm scenario to find work.
2. **Environment-limited:** host free memory fell to 15–18 MB (paging), so these runs measure this laptop as much
   as the application. They are reported, not used for capacity claims. Profile D also needs ~3.5 minutes just to
   log 1,500 accounts in at setup.

### What the failures were

For profile C, API logs plus nginx access logs for the window show the following:

- **744 × 201 and 47 × 503** on `POST /orders`;
- every 503 is `DB_POOL_EXHAUSTED`, returned after the 2 s pool-acquire timeout (one after 6.5 s including retries).

That is the designed fail-fast behaviour (R1.8): nothing hung, nothing was corrupted, and **invariants I1–I7 passed
after every run, including the overloaded ones.**

### Hot-SKU tail latency (open finding F-T4): where the time goes

| Evidence                 | Synthetic T4 (100 writers on 20 hot rows, pool 50) | Integrated workload, profile C     |
| ------------------------ | -------------------------------------------------- | ---------------------------------- |
| p99                      | 4.2–8.6 s (6 valid runs)                           | 23.4 s                             |
| Lock waiters (max)       | lock convoy by design                              | 5                                  |
| Longest open transaction | —                                                  | ~1.1 s                             |
| Orders-pool queue (max)  | —                                                  | **121** waiting for 10 connections |
| API CPU                  | —                                                  | **99 %** (1-CPU limit)             |
| Deadlocks                | 0 (negative control: 55–63)                        | 0                                  |

**Conclusion.**

- In the synthetic T4 test the tail is a **row-lock convoy** on hot rows, which is correct behaviour and never
  oversells.
- In the realistic workload the **first bottleneck is the API process (one CPU) and connection-pool queueing**, not
  row locks.
- The next measured steps are horizontal API replicas and pool sizing, re-measured with the same profiles.
- Redis cannot address either problem (see below), and it was not used to mask them.

## Redis off vs on (same workload)

Profile B (3 min) with **catalog browsing added** (a 50-item catalog page view before each order), run twice
back-to-back. The only variable was `REDIS_URL`; the containers were recreated in between.

| Run       | Orders | Order p50 / p95 / p99 | Order errors | Catalog p50 / p95 / p99 | Cache hits / misses | Max API CPU | Max PG CPU | I1–I7 |
| --------- | ------ | --------------------- | ------------ | ----------------------- | ------------------- | ----------- | ---------- | ----- |
| Redis off | 237    | 1.6 / 6.9 / 12.7 s    | 5.95 %       | 1.9 / 7.7 / 10.5 s      | —                   | 97 %        | 157 %      | PASS  |
| Redis on  | 241    | 1.5 / 5.6 / 7.1 s     | 6.23 %       | 2.1 / 6.5 / 7.4 s       | **4 / 226 (1.7 %)** | 92 %        | 125 %      | PASS  |

**Interpretation.**

1. **The catalog cache gave essentially no hits** under this workload.
   - Every order changes balances, so each store's catalog version was bumped about once a second (the coalescing
     limit), and the 5 s entries were invalidated before they could be reused.
   - That is a design weakness of the event-driven invalidation for a display-only cache.
   - **Next step:** rely on the TTL, with invalidation only on events that matter to a shopper (out of / back in
     stock), then re-measure.
2. Differences in order latency are within this machine's run-to-run variance. **No throughput improvement is
   claimed for Redis.**
3. The measured value of Redis is **correctness of limits across instances** (ADR-007). For example, two API
   instances without Redis allowed 12 of 12 login attempts against a limit of 6.
4. Adding catalog browsing made profile B considerably heavier (p95 1.7 s → 6.9 s without Redis). The catalog query
   runs against 5,000-product stores under a saturated API.

### Correction (2026-11-23): the A/B pair was partly environment-limited

The Redis-on run of the pair above recorded a minimum of **16 MB free host memory** (the Redis-off run: 432 MB). That
is the same paging condition that marks D and burst as environment-limited, and it was not flagged when the table
was written.

- Its absolute latencies are unreliable, and the pair is not a controlled comparison.
- The conclusions stand, and are only strengthened: no throughput claim for Redis, plus the measured 1.7 % hit rate.

## Final run (Phase 10, 2026-11-23)

Same profile B workload (3 min, with catalog browsing, Redis on) against the rebuilt images. This time OneDrive was
closed, and the minimum free host memory was 695 MB. Run: `phase6/runs/B-steady-final-phase10-2026-11-23T18-02-44-920Z`.

| Orders | Order p50 / p95 / p99 | Order errors | HTTP failed | Sync applied / rejected / shed | Sync p95 | Tasks completed | Max API CPU | Max orders-pool queue | Max lock waiters | Drain | I1–I7 |
| ------ | --------------------- | ------------ | ----------- | ------------------------------ | -------- | --------------- | ----------- | --------------------- | ---------------- | ----- | ----- |
| 257    | 219 / 820 / 1,217 ms  | 0 %          | 0 %         | 2,239 / 3 / 0                  | 553 ms   | 1,600           | 100 %       | 14                    | 5                | 2.3 s | PASS  |

- This is far better than the A/B runs on the same workload (p99 7.1–12.7 s, about 6 % errors). No change in the
  request path explains that.
- The difference lines up with machine state: 16–432 MB versus 695 MB minimum free memory, and OneDrive's leak.
- So it is evidence of how strongly this laptop's memory pressure dominated the earlier numbers, **not** an
  improvement claim.
- The API still peaked at 100 % of its single CPU: the bottleneck from F-T4 is unchanged.
- The reconnect-storm metric was empty in this run, so no storm figure is reported for it.

## Kafka and recovery timings (tests, not load)

| Scenario                                              | Measured                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Broker outage 60 s (K4), ~520 orders accepted         | broker reachable after restart in 13–19 s; outbox drained 16–37 s after `start`; all tasks created 24–43 s after `start` |
| Worker outage 30 s (K5 E1), backlog ~870–1,160 events | drained by one fresh worker in 6–30 s (incl. start-up)                                                                   |
| 10 worker SIGKILLs under load (Compose, E3)           | drained 34–57 s after the load stopped; the 30 s consumer session timeout dominates                                      |
| Redis outage (R1)                                     | logins 50–147 ms, catalog 17 ms from PostgreSQL; Redis used again 1.7 s after restart                                    |
