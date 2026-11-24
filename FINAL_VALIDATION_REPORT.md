# AisleForge — final validation report

**Final official run:** `audit/test-results/phase10/final-20261123T165033Z/`. It ran 2026-11-23 16:50 UTC to
2026-11-23 18:35 UTC, after a machine reboot.

**Environment.** Windows 11, 7.7 GB RAM, Docker Desktop 29.9.3 (WSL2 VM capped at 4 GiB), Node 24.11.1, pnpm 10.34.9.
Every result below was produced by an automated run in this directory, unless it names other evidence. Nothing here
is claimed without having run.

**Labels used:**

- **VERIFIED**: ran and passed, evidence saved.
- **NOT VERIFIED**: code exists, no passing test.
- **DEFERRED**: with a justification.
- **OPEN**: a known defect.

## 1. Completion

**92 % of requirements VERIFIED (85 of 92)**, counted per requirement in `PROJECT_COMPLETION_MATRIX.md`:

- **NOT VERIFIED (5).** The code exists, but no passing test covers:
  - the route-map display;
  - the sync pending/last-sync counters;
  - storage-quota handling.

  Also unverified: the git repository has no commits (commits are made only on the owner's instruction), and the CI
  workflow has never run on GitHub (that needs a push, which was not authorized).

- **DEFERRED (2), by decision:**
  - OR-Tools for multi-order batching (ADR-006);
  - failure experiments E5 (DB latency injection), E6 (API kill under load on Compose) and E7 (network partition).
    There is no Toxiproxy or `tc` on this machine, and only a single API replica on Compose.
- **0** in progress, not started or blocked.

## 2. Phase status

| Phase                   | Status                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| 0 Audit and design      | done (audit, ADR-001…007, connection budget)                            |
| 1 Database correctness  | VERIFIED (T1, T2, T4 + negative control, T6, T7, property test, I1–I7)  |
| 2 Kafka and events      | VERIFIED. The worker-crash defect D-K5 was found, root-caused and fixed |
| 3 Auth                  | VERIFIED (HTTP level and real Chromium)                                 |
| 4 Offline PWA           | VERIFIED in Chromium. 3 UI details not asserted by tests                |
| 5 Routing               | VERIFIED (OR-Tools batching deferred)                                   |
| 6 Stress and resilience | measured. E5/E6/E7 not executed                                         |
| 7 Redis                 | VERIFIED functionally. Measured 1.7 % cache hit rate: no speed claim    |
| 8 Docker, CI, hardening | VERIFIED locally. CI never run on GitHub                                |
| 9 Kubernetes / Helm     | VERIFIED on kind (12 live checks)                                       |
| 10 Final validation     | **this run**                                                            |

## 3. Final run: results by stage

Evidence for every stage: `audit/test-results/phase10/final-20261123T165033Z/`. Failed attempts are kept beside their reruns, and each failure and its fix is
listed. The run took about 1 h 45 min of machine time, paused once for memory.

| #   | Stage                                                                                                                      | Result                                                                    | Failed attempts and what they found                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0   | Pre-run state + SHA-256 of all 277 `audit/` files                                                                          | recorded (`pre-run-state.json`)                                           | an earlier attempt was aborted at the memory gate (`phase10/final-20261123T154124Z/NOTE.txt`)                            |
| 1   | Static: typecheck, lint, format, `pnpm audit` (high), helm lint ×2, kubeconform (24 resources), actionlint, compose config | **9/9 PASS**                                                              | lint failed on k6 globals in the load script, an earlier gap → ESLint config                                             |
| 2   | Unit + database (real PostgreSQL 18)                                                                                       | **19 files, 194/194 PASS**                                                | —                                                                                                                        |
| 3   | Kafka + Redis (real broker): K1–K5, R1                                                                                     | **6 files, 27/27 PASS**                                                   | —                                                                                                                        |
| 4   | Browser (Chromium, real stack)                                                                                             | **8/8 PASS**                                                              | all 8 passed, but teardown hit EBUSY on Windows → teardown fixed                                                         |
| 5   | Images: build, Trivy CI gate, non-root                                                                                     | **gate PASS ×3**; uid 1000/1000/101                                       | **api/worker had 8 CRITICAL / 86 HIGH** (stale Debian base + the unused npm CLI) → runtime image fixed                   |
| 6   | Compose smoke through nginx (10 steps)                                                                                     | **10/10 PASS**                                                            | 3 attempts failed on smoke-tool assumptions about a fresh DB (FIFO page, stale worker row); the stack itself was correct |
| 7a  | Load profile B (3 min)                                                                                                     | **0 % errors**, p50/p95/p99 219/820/1,217 ms, I1–I7 PASS                  | —                                                                                                                        |
| 7b  | E3: 10 × SIGKILL of the worker under load                                                                                  | **PASS**: 10/10 exit 137, 5,092 orders = 5,092 tasks, I1–I7               | —                                                                                                                        |
| 7c  | Backup → restore into a scratch DB                                                                                         | **PASS**: 16.9 MB, 22/22 tables match, live overwrite refused             | —                                                                                                                        |
| 8   | kind: Helm install + 12 live checks                                                                                        | **12/12 PASS**                                                            | 2 attempts had **1 × 503** on `/health/ready` during the rolling update (see §5)                                         |
| 9   | Static recheck after the fixes                                                                                             | all substantive checks PASS                                               | format: 4 docs being edited, formatted afterwards                                                                        |
| 10  | Audit integrity                                                                                                            | **0 of 277 pre-existing files changed or removed**; 68 new evidence files | —                                                                                                                        |

## 4. Results by area

**Kafka / events.**

- K1: the producer rejects instead of faking success.
- K2: orders become tasks with routes; duplicates are skipped; stale events are ignored.
- K3: poison messages go to a DLT (table + topic) with replay exactly once.
- K4: during a 60 s broker outage, orders are still accepted and drain afterwards.
- K5: 10 hard kills plus a 30 s outage, 582 orders = 582 tasks.
- Compose E3: 10 kills, 5,092 = 5,092.

**Offline PWA.**

- Picks, a short pick and completion survive a real browser restart while offline, and sync exactly once.
- A reassigned task is rejected and shown to picker and supervisor.
- Shared-device safety; two tabs reconnecting at once.
- Cookie flags, rotation and CSRF in Chromium.

**Stress.** Profiles A–C were measured (`docs/reports/PERFORMANCE_REPORT.md`); D and burst were limited by this
machine.

- F-T4: the first bottleneck is the single API CPU plus pool queueing, not row locks.
- Under overload the API fails fast with 503 and never corrupts data. I1–I7 passed after every run.
- Final profile B: 0 errors, p99 1.2 s.
- Correction: the earlier Redis A/B runs had as little as 16 MB of free memory, so their absolute numbers are
  unreliable.

**Redis.**

- Shared login throttle and rate limits across instances (with Redis the 7th attempt is refused; without it 12/12
  are allowed).
- An outage falls back within bounded time.
- Redis never decides a reservation.
- The catalog cache hit rate was only 1.7 %: invalidation is too eager. A redesign is documented.

**Compose.**

- Smoke 10/10; SIGTERM drains cleanly (worker 2.8 s, API 6.6 s); backup/restore verified.
- nginx re-resolves the API after restarts.

**CI.**

- `.github/workflows/ci.yml` runs static, unit+db, containers (Kafka/Redis), browser, Helm validation and images
  (Trivy gate, non-root, SHA tags; push only on manual opt-in).
- It is validated with actionlint, and every command ran locally. **It has never run on GitHub.**

**Kubernetes.**

- 12 live checks on kind: end-to-end, worker pod deletion, Redis outage, rolling update under traffic, rollback,
  PostgreSQL persistence on its PVC, and in-cluster backup/restore.
- Six defects were found only by deploying (`audit/test-results/phase9/README.md`).
- Kubernetes restarts things; it does not by itself make this system highly available (one PostgreSQL, one broker).

## 5. Defects

**Fixed and verified in this session:**

| Defect                                                                                                     | Found by         | Fix                                                                                                                                                                                                             | Verified by                                                            |
| ---------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **D-K5**: the worker crashed natively (Windows `0xC0000005`; Linux SIGSEGV at every fresh kind deployment) | K5, kind         | gdb backtrace: an Admin `ListConsumerGroupOffsets` response → librdkafka `rd_kafka_cgrp_op` on a client without a consumer group. Lag is now read through each consumer. Kafka clients are released before exit | reproduction 12/12 crashes → 0/10; 3 fresh kind deployments, 0 SIGSEGV |
| api/worker images: 8 CRITICAL / 86 HIGH                                                                    | final run, Trivy | Debian security updates; package managers removed from the runtime image                                                                                                                                        | gate passes; only unfixable findings remain                            |
| Concurrent demo seeding crash-looped replicas                                                              | kind             | advisory lock                                                                                                                                                                                                   | regression test fails without the lock, passes with it                 |
| Pods refused to start (`runAsNonRoot` with a named user)                                                   | kind             | numeric uid/gid                                                                                                                                                                                                 | kind                                                                   |
| nginx could not resolve the API on Kubernetes                                                              | kind             | fully qualified Service name                                                                                                                                                                                    | kind                                                                   |
| 503 during rolling updates (endpoint race)                                                                 | kind             | `preStop` delay                                                                                                                                                                                                 | partly; see the open finding below                                     |
| Browser-test teardown EBUSY; lint gap for k6; smoke tool assumed a fresh DB                                | final run        | test/tool fixes                                                                                                                                                                                                 | reruns                                                                 |

**Open:**

| Item                                                                                                                                           | Impact                                                                                                                                           | Status                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 × 503 from `/health/ready` during a kind rolling update, in 2 of 3 final-run attempts (raising `preStop` from 5 s to 10 s did not remove it) | the readiness endpoint only; **0 of 210 user (catalog) requests failed** across the three attempts (2 of 213 readiness probes returned 503)      | cause **not determined**: the answering pod was gone. The verifier now records response bodies, which tell `draining` from `not_ready` |
| librdkafka defect behind D-K5                                                                                                                  | any code calling `admin.fetchOffsets` while coordinators move can crash                                                                          | avoided in our code. An upstream report is recommended and was not filed (needs the owner's approval)                                  |
| Backlog after long downtime                                                                                                                    | after about a day offline, the sweeper expires stale reservations at about 200 per pass; the resulting events delay new tasks for about a minute | observed in the final run; drained in under 2 min; not optimized                                                                       |
| Remaining image CVEs                                                                                                                           | api/worker: zlib CVE-2023-45853 (CRITICAL) + 37 HIGH, none with a fix                                                                            | monitor; rebuild when fixes ship                                                                                                       |
| Catalog cache effectiveness                                                                                                                    | 1.7 % hit rate                                                                                                                                   | TTL-first redesign documented, not done                                                                                                |

## 6. How to run it

```powershell
# prerequisites: Node >= 22.12, pnpm 10, Docker Desktop; secrets in .env (see .env.example; never committed)
pnpm install
pnpm typecheck; pnpm lint; pnpm format:check          # static
pnpm test                                             # unit + db (embedded PostgreSQL 18, or TEST_DATABASE_URL)
docker compose up -d kafka redis; pnpm test:kafka     # real Kafka + Redis, incl. failure tests
pnpm test:e2e                                         # Playwright Chromium against the real stack
docker compose --profile app build
docker compose --profile app up -d                    # full stack on http://localhost:8088
pnpm tsx tools/smoke/compose-smoke.ts                 # 10-step check through nginx (SEED_PASSWORD from .env)
pnpm tsx tools/load/run-profile.ts B 3 steady demo    # k6 profile against Compose
pnpm tsx tools/failure/compose-worker-kill.ts         # runbook E3: 10 × SIGKILL of the worker under load
pnpm tsx tools/ops/backup-restore-check.ts            # backup → restore into a scratch DB → verify
kind create cluster --config deploy/kind/kind-config.yaml; pnpm tsx tools/k8s/verify-kind.ts   # Helm on kind, 12 live checks
pnpm tsx tools/failure/dk5-linux-repro.ts 6 90 demo   # D-K5 reproduction harness (fresh broker per iteration)
```

## 7. Interview demo walkthrough (about 15 minutes)

Preparation:

- Run `docker compose --profile app up -d` and wait until `docker compose ps` shows everything healthy.
- Open two browser profiles: one normal, one private.
- Log in with the demo accounts `customer@ / picker@ / supervisor@ / admin@demo.aisleforge.test`, password =
  `SEED_PASSWORD`.

**1. The problem (1 min).** Multi-store fulfilment where the expensive failures are:

- overselling the last unit;
- losing or duplicating work when a service crashes;
- pickers losing work on bad store Wi-Fi.

Show the README diagram. Say up front what this is not: a production deployment, high availability, or ML.

**2. Correct stock under concurrency (2 min).**

- _Customer:_ place an order.
- _Supervisor → Inventory:_ `reserved` went up in the same transaction.
- Explain the guarded `UPDATE … WHERE on_hand - reserved >= qty` (ADR-002).
- Show T1: 50 buyers race for the last unit, exactly one wins.
- Show T4: sorted lock order means 0 deadlocks; the negative control produces 55–63.
- Invariants I1–I7 run after every test and load run (`pnpm invariants`).

**3. Events without losing anything (3 min).**

- _Admin → Diagnostics:_ worker, outbox backlog and consumer lag.
- The outbox row is written in the same transaction as the order. The worker publishes to Kafka. The consumer
  deduplicates (`processed_events`) and commits its offset only after the database commit.
- Live: `docker compose kill -s SIGKILL worker` while placing orders. The worker restarts (supervised) and every order
  gets exactly one pick task.
- `docker compose stop kafka`: orders are still accepted (the outbox absorbs them). `start`: the backlog drains.

**4. Offline picking (4 min).**

- _Picker:_ the task appears with its planned route (S-shape / 2-opt / exact, cold-chain aware). Claim it.
- DevTools → Network → Offline. Scan two SKUs, record a short pick, complete. Close the tab.
- Reopen while still offline: the queue survived in IndexedDB.
- Go online: `/sync` applies each operation exactly once (op ids + per-device sequence).
- Conflict demo: the supervisor reassigns a task while the picker is offline. The picker's pick is **rejected**,
  shown to the picker, and listed for supervisor review.
- Security point: on a shared device, an offline sign-out cannot be resumed by the next person. That was a real
  defect, found by a browser test.

**5. Measured, not guessed (2 min).**

- `docs/reports/PERFORMANCE_REPORT.md`: profiles A–C on a laptop. The hot-SKU tail (F-T4) was investigated: the first
  bottleneck is the single API CPU plus pool queueing, not row locks. Under overload the API fails fast with 503 and
  never corrupts state.
- Redis honesty: the cache hit rate was 1.7 %, and that is reported. Redis earns its place through correct shared
  rate limits across instances, not speed.

**6. A real debugging story (2 min), D-K5.**

- The worker crashed natively, rarely on Windows and at every fresh Kubernetes deployment.
- Steps: a harness that reproduces it deterministically, a control that **disproved** the first theory, then a gdb
  backtrace into librdkafka (an Admin offset fetch → `rd_kafka_cgrp_op`, i.e. consumer-group code on a client that
  has no consumer group).
- Fixed in our code: 12/12 crashing iterations before, 0/10 after.
- Talking point: the evidence trail, including what was wrong along the way.

**7. Kubernetes (1 min, pre-recorded evidence).** `audit/test-results/phase9/README.md`:

- 12 live checks on kind;
- six defects that only real deployment exposed;
- rolling update with 256/256 requests served.

State plainly that Kubernetes restarts things but does not give high availability by itself.

**Questions to expect:**

- Why the outbox instead of publishing directly? (dual-write problem)
- Why not exactly-once Kafka transactions? (the effects are in PostgreSQL; dedupe there)
- What breaks first at 10× load? (the API CPU, then pool sizing)
- What would you do next? See §8.

## 8. Known gaps and next steps

**Not done, or not verified:**

- **Tests that are missing:** no test asserts the route-map display, the sync counters or storage-quota handling.
- **Failure experiments not run:** E5, E6 and E7, because there is no Toxiproxy/`tc` and only one API replica on
  Compose.
- **Unverified pipeline steps:**
  - no git commits;
  - CI never run on GitHub;
  - no image ever pushed (all of these deliberately wait for the owner's go-ahead).
- **Limited load evidence:** a single-laptop environment. Profiles D and burst were environment-limited, and the final
  run repeated only profile B.
- **Duration:** the runbook's 5-minute outages were shortened to 30–60 s.
- **Upstream:** the librdkafka defect is not reported upstream yet.

**Next steps, in order of value:**

1. Push to a private repository and let CI run (requires authorization).
2. Two API replicas behind nginx on Compose, then rerun C/D (the measured bottleneck is the single API CPU).
3. Add tests for the three unasserted UI details.
4. Redesign the catalog cache TTL-first and re-measure.
5. Report the librdkafka crash upstream with the reproduction harness.
6. Add Toxiproxy for E5/E7.

## 9. Where the evidence is

| What                                            | Where                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Final official run (this report)                | `audit/test-results/phase10/final-20261123T165033Z/`                  |
| Requirement matrix                              | `PROJECT_COMPLETION_MATRIX.md`                                        |
| Phase-by-phase status                           | `docs/IMPLEMENTATION_STATUS.md`, `PROJECT_STATUS.md`                  |
| Kafka runs, D-K5 investigation and reproduction | `audit/test-results/phase2/` (`RUNS.md`, `k5-investigation/`)         |
| Load runs (k6 summaries, 5 s server samples)    | `audit/test-results/phase6/runs/`                                     |
| Docker / Compose / backup                       | `audit/test-results/phase8/`                                          |
| Kubernetes on kind (every attempt)              | `audit/test-results/phase9/README.md`                                 |
| Development-run evidence (browser, Redis)       | `audit/test-results/dev-evidence-2026-11-22/`                         |
| Original audit (unchanged)                      | `audit/RETAILFLOW_AUDIT.md`, `audit/load-tests/`, `audit/prototypes/` |
| Reports                                         | `docs/reports/` (performance, failure injection, D-K5)                |
