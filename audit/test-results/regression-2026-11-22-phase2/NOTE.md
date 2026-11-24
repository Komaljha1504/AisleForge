# Regression evidence (unit + db projects) for the Phase 2 official runs

- Files without a `.run-` suffix, plus `unit-db-suite-summary.txt`: **official run 1** (2026-11-22 16:41 IST). 17 files,
  184/184 tests PASS.
- `unit-db-suite-summary.run2.txt` and every `*.run-2026-11-22T11-2*` / `T11-3*` JSON: **official run 2.
  ENVIRONMENT-INVALID.** Windows committed memory was at 23.1 of 23.7 GB, with heavy paging. T1's warm-pool
  precondition (50 distinct connections) failed with 45, and T7 timed out connecting. Not evidence of pass or fail;
  never use its timings.
- Run 3 writes into `../phase2/runs/run3-*/`.
