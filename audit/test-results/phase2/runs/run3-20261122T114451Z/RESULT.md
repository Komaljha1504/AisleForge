# Official Phase 2 run 3 — 2026-11-22 11:44:51 UTC

**Environment: VALID.**
- `environment-before.json`: 0.75 GB free physical memory, 18.95 of 23.74 GB committed, OneDrive 17 MB, Kafka 406 MiB.
- `environment-samples.csv` (every 10 s): minimum free physical memory 555 MB; maximum committed 20.26 GB; OneDrive at
  most 17 MB.

**Result: FAILED.** Two genuine failures.

| Stage | Result |
| --- | --- |
| typecheck / lint / format:check | PASS |
| unit + db (17 files) | 183/184. T1 stock=1: warm-up precondition opened 36 of 50 connections (timing-dependent harness; not an oversell). |
| Kafka (5 files) | 18/21. K1, K2, K3, K4: PASS. K5: E3 PASS; **E1 FAIL**, **no-self-death FAIL**, **I6 FAIL** (one root cause, next section) |
| Audit integrity | 92 pre-existing files under `audit/`: 0 changed |

## K5: the worker disappearance reproduced, with diagnostics

- Worker C exited **by itself with code 3221225477 = `0xC0000005` (access violation, a native crash)** at 11:52:12.85 UTC
  (`phase2/K5-worker-crash-E3-E1.json` → `workerExits`).
- C's log (`%TEMP%\aisleforge-test-logs\k5-1795348199416\C-14.log`, outside the repository) ends with:
  - 11:52:01.64 librdkafka `SESSTMOUT`: "Consumer group session timed out … after 6062 ms without a successful response
    from the group coordinator … revoking assignment";
  - 11:52:02.93 `REQTMOUT`: GroupCoordinator request timed out;
  - 11:52:09.84 "Error: all broker connections are down";
  - no `process exiting` line. A JS-level exit would have written one; the negative control proves it.
- Broker log (`docker logs aisleforge-kafka-1`): the broker **stalled from 11:51:49 to 11:52:09**. Its heartbeat to its
  own KRaft controller timed out. It then fenced C's consumer and unloaded group-coordinator partitions.
- With no worker left alive, the 212 remaining events stayed unconsumed. The harness reported "no live worker" within
  1 s instead of waiting for its timeout, and I6 failed. The harness behaved as designed.

Conclusion and follow-up: `docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md`.

## Fixes made after this run (not part of its evidence)

- `warmPool` now checks out all N clients at once (deterministic). T1 and T4 then passed in a dev run, with the
  assertion unchanged.
- Default production consumer session timeout raised to 30 s.

## Comparison with earlier valid runs (`tools/evidence/compare-phase2-runs.ts`)

Run 2 was environment-invalid and is excluded.

| Metric | Run 1 | Run 3 | Note |
| --- | --- | --- | --- |
| T4 orders/s / p99 | 138.6 / 4177 ms | 77.9 / 7661 ms | Same code; T4 varies 70.8–138.6 orders/s and 4.2–8.6 s p99 over 6 valid runs on this laptop. A dev run with the database also in `%TEMP%` gave 112 / 4894 ms, so the data-directory move does not explain it. Not benchmark-grade from single runs; Phase 6 measures it properly. |
| K1 ack (40 messages) | 711 ms | 254 ms | the first run includes producer connection and metadata set-up |
| K2 30 orders → tasks | 2151 ms | 2445 ms | within noise |
| K4 outage: orders accepted / errors / rows marked while down | 521 / 0 / 0 | 525 / 0 / 0 | identical behaviour |
| K4 recovery: broker reachable / drained / all tasks | 19.5 / 22.3 / 29.9 s | 13.2 / 16.0 / 23.6 s | mostly broker start-up time, which varies |
| K5 E3 duplicates skipped / drain after load | 1 / 8.1 s | 2 / 1.0 s | duplicates depend on kill timing |
