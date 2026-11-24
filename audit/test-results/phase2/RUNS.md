# Phase 2 official test runs: index

Files are never overwritten. A rerun writes `<name>.run-<timestamp>.json` next to the first file, or into its own
directory.

| Run | Started (IST) | Status | Files |
| --- | --- | --- | --- |
| aborted | 2026-11-22 16:33 | **Stopped deliberately** during unit+db, before the Kafka suite, to change the K5 harness | `../aborted-run-2026-11-22T11-03Z/` (per-test JSON only; see NOTE.txt) |
| 1 | 2026-11-22 16:41 | **FAILED (valid environment).** typecheck, lint and format clean; unit+db 184/184 PASS; Kafka 20/21. The K5 negative control found a real logging defect: pino's async stdout lost the worker's exit line. Fixed before run 2. | `K1-producer.json`, `K2-order-workflow.json`, `K3-poison-dlt-replay.json`, `K4-broker-outage-E2.json`, `K5-worker-crash-E3-E1.json`, `kafka-suite-summary.run1-FAILED-negative-control.txt`, `static-checks.run1.txt`, `audit-integrity-check.run1.txt`; unit+db summary in `../regression-2026-11-22-phase2/unit-db-suite-summary.txt` |
| 2 | 2026-11-22 16:53 | **ENVIRONMENT-INVALID. Not evidence of pass or fail.** Windows committed memory was at 23.1 of 23.7 GB (OneDrive had leaked to 3.5 GB private), with 16,948 pages/s and 83 % CPU. unit+db took 832 s instead of ~200 s: T1's warm-pool precondition failed and T7 timed out connecting. In the Kafka suite, K3 failed on a test race exposed by the slowness (fixed before run 3). Its numbers must not be used as benchmark evidence. | `K*.run-2026-11-22T11-39*` to `T11-41*` JSON siblings, `kafka-suite-summary.run2.txt`, `static-checks.run2.txt`, `audit-integrity-check.run2.txt`; `../regression-2026-11-22-phase2/unit-db-suite-summary.run2.txt` and every `*.run-2026-11-22T11-2*` / `T11-3*` JSON in that folder |
| 3 | 2026-11-22 17:14 | **FAILED (valid environment).** T1 failed on its timing-dependent warm-up precondition (fixed afterwards). K5: the worker disappearance reproduced as a **native crash, exit `0xC0000005`**, after a ~20 s broker stall. | `runs/run3-20261122T114451Z/` (see `RESULT.md`) |

`k5-investigation/` holds the source log excerpts for `docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md`.
