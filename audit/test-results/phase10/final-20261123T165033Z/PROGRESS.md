# Final run: stage index (complete)

Summary in `FINAL_VALIDATION_REPORT.md` §3 (repository root). Stage files in this directory:

| Stage | Final result | Files (failed attempts kept) |
| --- | --- | --- |
| 0 pre-run state + audit hashes | recorded | pre-run-state.json, audit-hashes-before.txt |
| 1 static | 9/9 PASS (attempt 2) | static-checks.attempt1-lint-failed-k6-globals.txt, static-checks.txt |
| 2 unit + db | 194/194 PASS | test-unit-db.txt, evidence/ |
| 3 Kafka + Redis | 27/27 PASS | test-kafka.txt, evidence/phase2, evidence/phase7 |
| 4 browser | 8/8 PASS (attempt 2) | test-e2e.attempt1-8passed-teardown-EBUSY.txt, test-e2e.txt |
| 5 images | Trivy gate PASS x3 (attempt 2) | images.attempt1-trivy-gate-failed-api-worker.txt, images.txt, trivy/ (attempt1/ kept) |
| 6 Compose smoke | 10/10 PASS (attempt 4) | compose.txt, evidence/phase8/compose-smoke.run-*.json (4 files) |
| 7a load B | 0 % errors, I1-I7 PASS | load-B.txt -> audit/test-results/phase6/runs/B-steady-final-phase10-2026-11-23T18-02-44-920Z |
| 7b E3 x10 | PASS | e3-compose-worker-kill.txt, evidence/phase6/ |
| 7c backup/restore | PASS | backup-restore.txt -> audit/test-results/phase8/backup-restore.run-2026-11-23T18-12-42-468Z.json |
| 8 kind | 12/12 PASS (attempt 3) | kind-verify.attempt1-*.txt, kind-verify.attempt2-*.txt, kind-verify.txt -> audit/test-results/phase9/ |
| 9 static recheck | substantive PASS; after the reports were finalized: format, lint, typecheck all PASS | static-checks.final-recheck.txt, static-checks.after-docs.txt |
| 10 audit integrity | 0 changed, 0 removed, 68 new | audit-integrity-check.txt |
