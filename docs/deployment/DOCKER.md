# Running AisleForge with Docker Compose

Everything below was executed on Windows 11 with Docker Desktop 4.99 (WSL2 VM capped at 4 GiB). Results are in
`audit/test-results/phase8/` and `audit/test-results/phase6/`.

## Images (`Dockerfile`, multi-stage, one file and three targets)

| Target   | Base                                                        | Runs as           | Contents                                                                                                         | Health check            |
| -------- | ----------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `api`    | `node:22.12.0-bookworm-slim`                                | `node` (uid 1000) | esbuild bundle `api.mjs`, `init-db.mjs`, `load-seed.mjs`, migrations; native modules only (Kafka client, argon2) | `GET /health/live`      |
| `worker` | same                                                        | `node` (uid 1000) | `worker.mjs`, `init-db.mjs`                                                                                      | `GET :8081/health/live` |
| `web`    | `nginxinc/nginx-unprivileged:1.31.7-alpine` + `apk upgrade` | `nginx` (uid 101) | built PWA + same-origin reverse proxy (`deploy/nginx/default.conf.template`)                                     | `GET /healthz`          |

- The images contain **no secrets**; all configuration is injected at runtime.
- Sizes: web 74 MB, api and worker about 375 MB each.
- Trivy 0.58.1 (fixable CRITICAL/HIGH): **0 / 0 for all three images** after fixes:
  - The first web base (nginx 1.27.3) had 3 CRITICAL and 37 HIGH, mostly OpenSSL.
  - Stable 1.30.6 still had 4 CRITICAL in nginx itself.
  - Moving to mainline 1.31.7 plus `apk upgrade` cleared them.

## Configuration and secrets

`docker compose` reads `.env`, which git ignores and which must never be committed. Required values:

```dotenv
POSTGRES_PASSWORD=<random, URL-safe>
JWT_SECRET=<>= 32 random characters>
SEED_PASSWORD=<demo accounts' password, >= 12 chars>   # only to seed demo data
PUBLIC_ORIGIN=http://localhost:8088
REDIS_URL=redis://redis:6379                             # optional; empty = Redis disabled
```

Generate them with a cryptographic RNG, as `.env` was generated locally (PowerShell
`System.Security.Cryptography.RandomNumberGenerator`, or `openssl rand -hex 32`). In Kubernetes the same keys come
from a Secret (see `KUBERNETES.md`).

## Start, verify, stop

```powershell
docker compose --profile app build                  # or: docker build --target api|worker|web …
docker compose --profile app up -d                  # postgres, kafka, redis, migrate (one-shot), api, worker, web
docker compose --profile app ps                     # all healthy (measured: 26 s from up to healthy)
$env:SEED_PASSWORD = '<from .env>'; pnpm tsx tools/smoke/compose-smoke.ts   # end-to-end through http://localhost:8088
docker compose --profile app stop                   # SIGTERM: worker stops in 2.8 s, API in 6.6 s (exit 0)
```

Open `http://localhost:8088`. The demo accounts (`customer@`, `picker@`, `picker2@`, `supervisor@`, `admin@demo.aisleforge.test`) use `SEED_PASSWORD`.

## Behaviour verified on this stack

| Check                                                                                                                                                            | Result                                                                                                                                    | Evidence                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Full workflow through nginx: order → stock reserved → outbox → Kafka → containerized worker → task → claim → sync picks + completion → order picked; diagnostics | 10/10 steps PASS                                                                                                                          | `phase8/compose-smoke.run-*.json`             |
| Graceful SIGTERM (Linux)                                                                                                                                         | worker: `shutdown started (SIGTERM)` → `worker stopped` → `process exiting code 0`; API: `shutdown started` → `shutdown complete`, exit 0 | `phase8/sigterm-graceful-shutdown.run-*.json` |
| Runbook E3: `docker compose kill -s SIGKILL worker` ×10 under load                                                                                               | every kill exit 137, worker never died by itself, 1,213 orders = 1,213 tasks, I1–I7 PASS, drained 34 s after load                         | `phase6/E3-compose-worker-kill.run-*.json`    |
| API restarted with a NEW IP                                                                                                                                      | front door keeps working (nginx re-resolves the upstream every 10 s)                                                                      | fixed defect, see below                       |
| Backup → restore into a separate database → row counts and invariants                                                                                            | see `phase8/backup-restore.run-*.json`                                                                                                    | `deploy/scripts/backup.sh`, `restore.sh`      |

## Defects found by running it (all fixed)

- `init-db.mjs` seeded **before** migrating: a bundling side effect of an `import.meta.url` entry-point check.
- nginx dropped the security headers on the app shell (an `add_header` inheritance rule).
- nginx kept a stale API IP after an API restart, so every API call got 502 until nginx restarted. It now
  re-resolves the upstream through a resolver.
- Corepack failed signature verification of pnpm inside `node:22.12`; pnpm is now installed with npm instead.
- The new workspace package was missing from the image's dependency layer.

## Backups

```sh
deploy/scripts/backup.sh /path/outside/synced/folders      # pg_dump custom format + .sha256
deploy/scripts/restore.sh <dump> [target-db]                # default target: aisleforge_restore_check (non-destructive)
CONFIRM_RESTORE=yes deploy/scripts/restore.sh <dump> aisleforge --force   # replace the LIVE database (explicit)
```

PostgreSQL is the only system of record. After a restore:

- outbox rows with `published_at IS NULL` are published again, and consumers deduplicate them;
- Redis refills on demand.
