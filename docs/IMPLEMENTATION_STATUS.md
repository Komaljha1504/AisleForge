# AisleForge — Implementation status

Legend: **Not started · In progress · Blocked · Implemented** (code exists) **· Tested** (automated tests pass)
**· Verified** (tested end-to-end in the target environment with invariants).
Last updated: 2026-11-22 (Phases 2, 4, 6, 7, 8 and 9 recorded; Phase 10 final validation pending). The
requirement-level acceptance view is `PROJECT_COMPLETION_MATRIX.md`.

## Engineering review items (2026-11-21)

| #   | Item                                                  | Outcome                                                                                                                                                                                                                                    | Where                                                                                                                                                                       |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Account lockout could be abused to deny access        | **Weakness confirmed by test, redesigned, re-tested.** Per (account, source) progressive temporary locks; account-wide threshold that exempts known sources; admin unlock                                                                  | ADR-005 §Brute-force; `tests/security/lockout-abuse.test.ts`; `tests/unit/login-throttle.test.ts`; before/after evidence in `audit/test-results/phase3/lockout-abuse*.json` |
| 2   | Compare against OR-Tools seeded with a feasible route | **Done, recorded separately.** OR-Tools seeded with the planner route improved it by 0–1.12 % (unconstrained, 3 s) and 0.04–2.17 % (cold-chain, 1 s); never worse; all feasible. Planner routes above 12 picks are **not** claimed optimal | ADR-006 comparison 2; `audit/test-results/phase5/ortools-seeded-comparison.{json,md}` (existing `route-benchmark.*` unchanged)                                              |
| 3   | 10-minute access-token logout gap                     | **Kept by decision**; no denylist / per-request session lookup. Real-browser cookie verification added as a Phase 4 requirement                                                                                                            | ADR-005 limitations 1 and 5                                                                                                                                                 |
| 4   | Route planner scope                                   | TypeScript implementation and results preserved; **no Python/OR-Tools service for single routes**; OR-Tools deferred to multi-order batching                                                                                               | ADR-006                                                                                                                                                                     |
| 5   | Phase 2                                               | **Remains BLOCKED** until Docker Desktop and a real Kafka broker run; no simulated broker success counts                                                                                                                                   | ADR-003 completion conditions                                                                                                                                               |

## Independent re-verification (2026-11-22)

Fresh run before Phase 2:

- typecheck, lint and format:check: clean.
- **16 files, 180/180 tests passing** in 183 s.
- Rerun evidence is in `audit/test-results/reverify-2026-11-22/`, including `full-suite-summary.txt`.
- SHA-256 of all 36 pre-existing `audit/` files was compared before and after the run: **0 changed**.

Defect found and fixed: `writeEvidence` overwrote earlier evidence on every run. This had already replaced the
original T4 file. See the evidence correction in ADR-002. Re-verification runs now set `AISLEFORGE_EVIDENCE_ROOT`.

## Environment

Docker Desktop 4.99.0 (Engine 29.9.3, Compose v5.7.0) is running on WSL2, with the VM capped at 4 GiB.
`docker run hello-world` passed on 2026-11-22. Project-wide status is tracked in `PROJECT_STATUS.md` and
`PROJECT_COMPLETION_MATRIX.md` at the repository root.
With the runtime available, Phase 2 was completed first, then Phases 4, 6, 7, 8 and 9 in order. The local tools
used were kind 0.25.0 and helm 3.16.3 (both checksum-verified), kubeconform 0.6.7, actionlint 1.7.4, Trivy 0.58.1 and
k6 0.55 (the last four as containers). No Toxiproxy or `tc` exists on this machine (see Phase 6).

## Phase 0 — Inspection & design

| Item                                        | Status      | Evidence                                   |
| ------------------------------------------- | ----------- | ------------------------------------------ |
| Audit/prototype review, contradictions list | Implemented | `docs/architecture/PHASE0_AUDIT_REVIEW.md` |
| ADRs 001–006                                | Implemented | `docs/decisions/`                          |
| Connection budget                           | Implemented | `docs/deployment/CONNECTION_BUDGET.md`     |

## Phase 1 — Foundation & database — **complete (Tested)**

| Item                                                                                   | Status      | Evidence                                            |
| -------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| Monorepo, strict TS, ESLint, Prettier                                                  | Tested      | typecheck / lint / format clean                     |
| Schema (balance CHECKs, append-only ledger, orders, reservations, idempotency, outbox) | Tested      | `tests/integration/inventory-orders.test.ts`        |
| Guarded atomic all-or-nothing reservation, sorted locks                                | Tested      | T1, T4 (+ negative control)                         |
| Principal-scoped idempotency                                                           | Tested      | T2                                                  |
| Reservation CAS state machine, expiry, pick/short pick, cancel                         | Tested      | T7                                                  |
| Invariants I1–I5                                                                       | Tested      | `audit/load-tests/invariants.sql`                   |
| Property test (100 programs, concurrent)                                               | Tested      | `audit/test-results/phase1/property-inventory.json` |
| Pool-timeout → 503 path                                                                | Implemented | exercised in Phase 6 load tests                     |

Phase 1 code was not changed by Phase 3/5 except: `orders/queries.ts` (new, scoped reads) and the outbox backlog
helper moved into the domain package. All Phase 1 tests still pass in the latest full run.

## Phase 2 — Event-driven backend — **Functionally tested against a real broker; acceptance OPEN (defect D-K5)**

All tests below ran against Kafka 4.1.1 (KRaft, Docker Compose) and real PostgreSQL. There are no mocks. Run history
(two failed runs and one environment-invalid run, all kept) is in `audit/test-results/phase2/RUNS.md`.

| Item                                                                                | Status          | Evidence                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka KRaft in Compose; topics created explicitly (auto-create off)                 | Tested          | `docker-compose.yml`, all K tests                                                                                                                                                     |
| Producer adapter (acks=all, idempotent, bounded; rejects instead of faking success) | Tested          | K1                                                                                                                                                                                    |
| Outbox publisher: single leader, publish-then-mark, never marks without an ack      | Tested          | T6, K4 (0 rows marked during a 60 s outage)                                                                                                                                           |
| Consumer: dedupe + effects in one transaction, offset after commit, stale versions  | Tested          | K2 (60/60 redeliveries deduplicated; stale → no effect)                                                                                                                               |
| Order → pick task with planned route; routing fallback/infeasible/unplanned         | Tested          | K2                                                                                                                                                                                    |
| Correlation id HTTP → order → outbox → Kafka → task                                 | Tested          | K2                                                                                                                                                                                    |
| Poison messages, bounded retries, DLT topic + table, admin replay/discard (audited) | Tested          | K3 (E8)                                                                                                                                                                               |
| Broker outage (`docker compose stop kafka`, 60 s)                                   | Tested          | K4 (E2): ~520 orders accepted, 0 errors, drained after restart                                                                                                                        |
| Worker hard kills ×10 under load; full worker outage                                | Tested          | K5 (E3, E1)                                                                                                                                                                           |
| Invariant I6                                                                        | Tested          | K2–K5                                                                                                                                                                                 |
| Worker diagnostics (`/status`, `worker_status` → API `/internal/status`)            | Verified        | K2 (lag); e2e admin diagnostics page; worker probes on kind                                                                                                                           |
| Graceful SIGTERM shutdown                                                           | Verified        | Linux container: 2.8 s, exit 0 (`audit/test-results/phase8/sigterm-*`)                                                                                                                |
| **D-K5: native worker crash (`0xC0000005` Windows / SIGSEGV 139 Linux)**            | **OPEN DEFECT** | Reproduced on Linux at every fresh kind deployment (worker starting while the broker loads). `docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md`. Mitigated by supervised restart |

Defects found and fixed in Phase 2:

- evidence overwriting;
- `localhost` → IPv6 resolution;
- vague dead-letter reasons;
- the test database inside OneDrive (EBUSY);
- the test harness losing stderr;
- pino's async logging losing the worker's final lines;
- a K3 test race;
- T1's timing-dependent warm-up.

## Phase 3 — Authentication & authorization — **Tested** (one item unverified, see notes)

| Item                                                                                                                             | Status                        | Evidence                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Argon2id hashing, password policy, constant-work login                                                                           | Tested                        | `tests/security/authentication.test.ts`                                                                            |
| JWT access tokens (alg allow-list, iss/aud/exp, claim schema)                                                                    | Tested                        | forged/tampered/none/expired/wrong-aud/unknown-role → 401                                                          |
| Refresh cookie (HttpOnly/Secure/SameSite=Strict/Path), hashed storage                                                            | Tested                        | same                                                                                                               |
| Rotation + reuse detection (family revocation), logout, role change revokes sessions                                             | Tested                        | same                                                                                                               |
| CSRF (custom header + Origin), CORS allow-list                                                                                   | Tested                        | same                                                                                                               |
| Brute force: per-(account, source) progressive locks, account-wide threshold exempting known sources, per-IP limits (in-process) | Tested                        | `tests/security/lockout-abuse.test.ts` (5), `tests/unit/login-throttle.test.ts` (9); Redis-backed state is Phase 7 |
| Lockout-abuse resistance (attacker cannot lock out the real user)                                                                | Tested                        | was FAILING before the redesign: `audit/test-results/phase3/lockout-abuse-BEFORE-fix.json`                         |
| Admin login-throttle unlock (audited)                                                                                            | Tested                        | `POST /api/v1/admin/users/:id/unlock-login`; with Redis it clears the shared state (Phase 7)                       |
| Secure-cookie behaviour in a real browser (HttpOnly, SameSite, Secure, Path, single-flight refresh)                              | Verified                      | Playwright Chromium, `tests/e2e/auth.spec.ts`                                                                      |
| 10-minute access-token validity after logout/role change                                                                         | Accepted limitation           | kept by decision (review item 3)                                                                                   |
| RBAC × store matrix (7 endpoints × roles)                                                                                        | Tested                        | `tests/security/authorization.test.ts`, `audit/test-results/phase3/authorization-matrix.json`                      |
| Store isolation / BOLA (orders read/list/cancel, inventory write)                                                                | Tested                        | same                                                                                                               |
| Privilege escalation & mass assignment                                                                                           | Tested                        | same                                                                                                               |
| Injection probes rejected before SQL; forged cursor → 400                                                                        | Tested                        | same                                                                                                               |
| Log redaction (password, access and refresh tokens absent from logs)                                                             | Tested                        | same                                                                                                               |
| Health: liveness independent of DB, readiness checks DB                                                                          | Tested                        | `tests/integration/api-orders.test.ts`                                                                             |
| `/internal/status` (admin only): pools, tx stats, outbox backlog, event-loop delay                                               | Tested                        | same                                                                                                               |
| Correlation id HTTP → order row → ledger → outbox                                                                                | Tested                        | same (Kafka → consumer leg blocked with Phase 2)                                                                   |
| Real process boot over TCP (config refusal, ready, auth flow)                                                                    | Tested                        | `tools/smoke/api-process-smoke.ts` → `audit/test-results/phase3/api-process-smoke.json` (9/9)                      |
| Graceful SIGTERM drain                                                                                                           | Verified                      | Linux container 6.6 s, exit 0; kind rolling update 256/256 requests OK                                             |
| Dependency / container vulnerability scanning                                                                                    | Implemented (CI), run locally | `pnpm audit` high gate; Trivy CRITICAL gate in CI; local scan evidence in the Phase 10 run                         |

## Phase 4 — Employee PWA & offline sync — **Tested in a real browser** (three items not asserted)

React + Vite + Tailwind PWA (`apps/web`); the server side is in `packages/domain/src/picking`, `packages/domain/src/sync`
and `apps/api/src/routes/picking.ts`. Protocol: ADR-004. The browser tests run Chromium (Playwright) against the real
stack: embedded PostgreSQL, API and worker processes, Kafka, and `vite preview` of the built PWA.

| Item                                                                                                    | Status      | Evidence                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------- |
| Pick-task list, lease claim/release, reservations extended while leased                                 | Tested      | `tests/integration/picking-sync.test.ts` (8)                   |
| Idempotent `/sync` (applied / duplicate / rejected / retry), per-device sequence, I7, 429 load shedding | Tested      | same                                                           |
| Offline picking, short pick and completion surviving a **real browser restart**, synced exactly once    | Tested      | e2e offline                                                    |
| Task reassigned while offline → rejection visible to picker and supervisor                              | Tested      | e2e offline                                                    |
| Shared device: queued work stays with its employee; offline sign-out cannot be resumed by the next user | Tested      | e2e (security defect found and fixed)                          |
| Two tabs reconnecting at once upload the queue once (Web Locks + BroadcastChannel)                      | Tested      | e2e                                                            |
| Cookies, CSRF, refresh rotation, reuse detection in Chromium                                            | Tested      | e2e auth                                                       |
| Customer shop/order/cancel, supervisor overview + restock, admin diagnostics/dead letters/users         | Tested      | e2e ui                                                         |
| Route map on the pick screen                                                                            | Implemented | rendered; no test asserts it                                   |
| Sync status: pending counter, last-sync time                                                            | Implemented | the online/offline indicator is asserted; the counters are not |
| Storage-quota handling (`StorageFullError`)                                                             | Implemented | no test fills the quota                                        |

## Phase 5 — Route optimization — **Tested** (application integration blocked on Phase 2)

| Item                                                                                             | Status               | Evidence                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Warehouse graph + Dijkstra; matches prototype matrices exactly                                   | Tested               | `tests/unit/routing.test.ts`                                                                                               |
| NN, 2-opt, Or-opt, S-shape, Held–Karp; properties (permutation, never worse, exact ≤ heuristics) | Tested               | same                                                                                                                       |
| Cold-chain exposure constraints (time/distance to hand-off); infeasible → no stops               | Tested               | same (property: never returns an infeasible route as valid)                                                                |
| Fallback (optimizer failure → S-shape), time budget, input limits                                | Tested               | same                                                                                                                       |
| Benchmark vs prototype on identical instances                                                    | Tested               | `audit/test-results/phase5/route-benchmark.{json,md}`                                                                      |
| Comparison with OR-Tools seeded by the planner route (same instances/limits)                     | Tested               | `audit/test-results/phase5/ortools-seeded-comparison.{json,md}`; planner routes are not optimal above 12 picks (gap 0–2 %) |
| Plan routes for real pick tasks (worker)                                                         | Tested               | K2 (feasible / fallback / infeasible), e2e, kind                                                                           |
| OR-Tools service                                                                                 | Deferred by decision | not for single routes (review item 4); only to be evaluated for multi-order batching (ADR-006)                             |

## Phase 6 — Stress and resilience — **Measured** (three experiments not executed)

k6 profiles A–D, a 10× burst and a reconnect storm against the full Compose stack, with invariants after every run.
Numbers and interpretation: `docs/reports/PERFORMANCE_REPORT.md`. Failure experiments:
`docs/reports/FAILURE_INJECTION_REPORT.md`.

- **F-T4 (hot-SKU tail):** under the realistic workload, the first bottleneck is the single API CPU and connection-pool
  queueing (121 waiting), not row locks (at most 5 waiters). The synthetic T4 tail is a lock convoy that never oversells.
- **Not executed:** E5 (no Toxiproxy/`tc`), E6 on Compose (single API replica), E7 (network partition).
- D and burst were limited by this machine (15–18 MB free host memory) and are not used for capacity claims.

## Phase 7 — Redis — **Tested** (ADR-007)

Shared login throttle and rate limits (multi-instance), a catalog cache with versioned keys, bounded timeouts and
fallbacks. R1 (6 tests) ran against a real Redis, including `docker compose stop redis`. The A/B load comparison
measured a **1.7 % cache hit rate**: event-driven invalidation is too eager for this workload. A TTL-first redesign is
documented, not implemented. No throughput gain is claimed. PostgreSQL decides every reservation.

## Phase 8 — Docker, CI/CD, hardening — **Tested locally**; CI never run on GitHub

- Multi-stage Dockerfile (api, worker, web), non-root, `apk upgrade` on the nginx image.
  - Trivy found 3 CRITICAL / 37 HIGH in the original web image, then 0/0 after the upgrade.
- Compose stack with limits, volumes, a migration job and a supervised worker. Smoke test 10/10.
- SIGTERM drain verified in Linux containers.
- Backup/restore tested, with a non-destructive default.
- The nginx stale-upstream defect was found and fixed.
- CI (`.github/workflows/ci.yml`):
  - validated with actionlint;
  - each job's commands ran locally;
  - **the workflow has not run on GitHub**, because nothing was pushed without authorization;
  - the Helm lint + kubeconform job was added after Phase 9.

## Phase 9 — Kubernetes / Helm — **Verified on kind** (`docs/deployment/KUBERNETES.md`)

12/12 live checks:

- end-to-end flow;
- worker pod deletion;
- Redis outage;
- rolling update under continuous traffic (256/256 OK);
- rollback;
- PostgreSQL persistence on its PVC;
- in-cluster backup/restore.

Six defects were found only by deploying, including a concurrent-seeding race (regression test with a negative
control) and an endpoint-propagation 503 during rollouts. All are fixed except D-K5, which reproduces at every fresh
deployment. Attempt history: `audit/test-results/phase9/README.md`.

## Phase 10 — Final validation — **done** (`audit/test-results/phase10/final-20261123T165033Z/`)

One official run (2026-11-23):

- static 9/9;
- unit+db 194/194;
- Kafka+Redis 27/27;
- Chromium 8/8;
- images (Trivy gate, non-root);
- Compose smoke 10/10;
- load profile B (0 % errors);
- E3 ×10;
- backup/restore;
- kind 12/12;
- audit integrity (0 of 277 files changed).

Defects found by the run and fixed:

- api/worker image CVEs;
- a k6 lint gap;
- e2e teardown EBUSY;
- smoke-tool assumptions about a fresh database.

D-K5 was fixed beforehand and confirmed here: 0 SIGSEGV on fresh kind deployments.

Open: an intermittent readiness-probe 503 during kind rolling updates, cause not determined. Every failed attempt is
kept beside its rerun. Full account: `FINAL_VALIDATION_REPORT.md`.

## Test inventory — final run 2026-11-23

| Suite                                                                                                         | Files | Tests | Result           |
| ------------------------------------------------------------------------------------------------------------- | ----- | ----- | ---------------- |
| unit + db (`pnpm test`): unit, integration, concurrency (T1/T2/T4/T6/T7/property), security, seed concurrency | 19    | 194   | all pass (427 s) |
| kafka (`pnpm test:kafka`): K1–K5, R1 (real Kafka + Redis, incl. outages)                                      | 6     | 27    | all pass (451 s) |
| e2e (`pnpm test:e2e`): Playwright Chromium against the real stack                                             | 3     | 8     | all pass         |

Separately executed tools in the same run:

- Compose smoke (10 steps);
- k6 profile B;
- E3 worker kills;
- backup/restore check;
- kind verification (12 checks).

Also available: the D-K5 reproduction harness (`tools/failure/dk5-linux-repro.ts`) and the route benchmarks (Phase 5).
