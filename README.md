# AisleForge — Intelligent Retail Fulfillment & Resilience Platform

A multi-store retail fulfilment system built for **correctness under concurrency and failure**. Its main parts:

- transactional inventory reservation in PostgreSQL;
- a transactional outbox feeding Apache Kafka, with idempotent consumers, dead letters and replay;
- an offline-first employee PWA (IndexedDB + Service Worker) with an idempotent sync protocol;
- algorithmic pick-route planning;
- Redis for shared rate limits and caching (never as a source of truth);
- Docker Compose, CI, and Kubernetes via Helm.

It is inspired by general large-scale retail engineering problems and does not reproduce any company's proprietary
architecture.

> **Status:** see [PROJECT_STATUS.md](PROJECT_STATUS.md) and the requirement-level
> [PROJECT_COMPLETION_MATRIX.md](PROJECT_COMPLETION_MATRIX.md). Every claim is labelled Implemented, Tested or
> Verified, with evidence in `audit/test-results/`. Open defects and gaps are listed there, not hidden.

## The workflow, end to end

```
Customer (PWA) ── POST /orders ──► API ── one PostgreSQL transaction: guarded stock reservation + ledger + outbox row
                                                     │
                       worker: outbox publisher (single leader) ──► Kafka (KRaft) ──► order-workflow consumer
                                                     │                     (dedupe + effects in one transaction)
                                                     ▼
                              pick task + planned route (S-shape / NN+2-opt / Or-opt / exact, cold-chain aware)
                                                     │
Picker (PWA, works offline) ── claim (online) ── scan/pick/complete → IndexedDB op log ── POST /sync (idempotent)
                                                     │
                         ledger: pick / short_pick · order → picked · events → Kafka · catalog cache invalidated
```

## Run it (Docker Compose)

```powershell
# 1. Secrets in .env (never committed): POSTGRES_PASSWORD, JWT_SECRET (>= 32 chars), SEED_PASSWORD, PUBLIC_ORIGIN, REDIS_URL
docker compose --profile app build
docker compose --profile app up -d          # postgres, kafka, redis, migrate (+ demo seed), api, worker, web
# 2. Open http://localhost:8088. Demo users: customer@ / picker@ / picker2@ / supervisor@ / admin@demo.aisleforge.test
#    (password = SEED_PASSWORD)
$env:SEED_PASSWORD = '…'; pnpm tsx tools/smoke/compose-smoke.ts    # 10-step end-to-end check through nginx
```

Kubernetes (kind + Helm): [docs/deployment/KUBERNETES.md](docs/deployment/KUBERNETES.md). Docker details, secrets
and backups: [docs/deployment/DOCKER.md](docs/deployment/DOCKER.md).

## Test it

Requirements: Node ≥ 22.12, pnpm 10, and Docker for the container suites.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test            # unit + db: real PostgreSQL 18 (embedded, or TEST_DATABASE_URL)
docker compose up -d kafka redis
pnpm test:kafka      # Kafka + Redis integration and failure tests (real broker; stops and starts containers)
pnpm test:e2e        # Playwright (Chromium) against the real stack: cookies/CSRF, offline + restart, conflicts
SEED_PASSWORD=… pnpm tsx tools/load/run-profile.ts B 3 steady mylabel   # k6 load profile against Compose
pnpm tsx tools/failure/compose-worker-kill.ts                            # runbook E3 on Compose
pnpm tsx tools/ops/backup-restore-check.ts                               # backup → restore → verify
pnpm tsx tools/k8s/verify-kind.ts                                        # Helm deploy to kind + live checks
DATABASE_URL=… pnpm invariants                                           # global invariants I1–I7
```

## Layout

```
apps/api            Express 5 API: auth, orders, inventory, picking/sync, catalog, admin diagnostics, dead letters
apps/worker         outbox publisher, Kafka consumers (order-workflow, catalog-cache), DLT replayer, sweeper
apps/web            React + Vite + Tailwind PWA (customer, picker, supervisor, admin; offline-first picking)
packages/domain     inventory, orders, identity, picking (leases), offline sync, catalog
packages/routing    warehouse graph + route planner
packages/cache      Redis client, shared limiter, catalog cache (optional; bounded; fallbacks)
packages/database   bounded pools, transactions, migrations, invariants · packages/events · packages/validation
migrations/         forward-only SQL (0001–0004)
deploy/             nginx config, helm chart, kind config, backup/restore scripts
load-tests/k6/      corrected k6 workload (the audit template is kept unchanged under audit/)
tests/              unit, integration, concurrency, security, kafka (real broker), e2e (Playwright)
tools/              seed, smoke, load, failure injection, backup check, kind verification, evidence tools
audit/              original audit evidence (unchanged) + all test results (audit/test-results/)
docs/               ADRs, architecture, deployment guides, reports
```

## Documents

- Decisions: [ADR-001 Architecture](docs/decisions/ADR-001-architecture.md) ·
  [002 Reservation](docs/decisions/ADR-002-inventory-reservation.md) ·
  [003 Outbox & Kafka](docs/decisions/ADR-003-outbox-and-events.md) ·
  [004 Offline sync](docs/decisions/ADR-004-offline-sync-protocol.md) ·
  [005 Auth](docs/decisions/ADR-005-authentication-authorization.md) ·
  [006 Route planning](docs/decisions/ADR-006-route-planning.md) ·
  [007 Redis](docs/decisions/ADR-007-redis.md)
- API: [endpoint reference](docs/API.md)
- Architecture: [Kafka event processing](docs/architecture/KAFKA_EVENT_PROCESSING.md) ·
  [Phase 0 audit review](docs/architecture/PHASE0_AUDIT_REVIEW.md)
- Deployment: [Docker](docs/deployment/DOCKER.md) · [Kubernetes](docs/deployment/KUBERNETES.md) ·
  [Connection budget](docs/deployment/CONNECTION_BUDGET.md)
- Reports: [Performance](docs/reports/PERFORMANCE_REPORT.md) ·
  [Failure injection](docs/reports/FAILURE_INJECTION_REPORT.md) ·
  [Worker crash investigation (D-K5)](docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md) ·
  [Final validation](FINAL_VALIDATION_REPORT.md)
- Tracking: [Implementation status](docs/IMPLEMENTATION_STATUS.md)
