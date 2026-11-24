# Kubernetes and Helm

The Helm chart is in `deploy/helm/aisleforge/`. It was **deployed to a real local cluster (kind) and verified there**
on 2026-11-22: rendering the YAML was not treated as a deployment.

> **What Kubernetes does and does not give you here.** Kubernetes restarts crashed containers, replaces deleted pods,
> rolls out new versions without dropping traffic (measured below), and keeps data on PVCs across pod restarts.
> It does **not** make the system highly available by itself:
>
> - The local data tier is a single PostgreSQL, a single Kafka broker and a single Redis, all on one node.
> - In production, the data tier is meant to be external and managed (`values.yaml`).

## What the chart contains

| Component                          | Kind                                                                      | Notes                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api                                | Deployment (2 replicas), Service, PodDisruptionBudget (`minAvailable: 1`) | Rolling update `maxUnavailable: 0`, `maxSurge: 1`. Probes: startup and liveness on `/health/live` (process only), readiness on `/health/ready` (PostgreSQL reachable and not draining). `preStop` sleep 10 s. Read-only root filesystem. |
| worker                             | Deployment (1 replica), Service (status port)                             | Probes on the worker's status server. One replica holds the outbox-publisher leadership (advisory lock); consumers share partitions.                                                                                                     |
| web                                | Deployment, Service, optional Ingress                                     | nginx (unprivileged, uid 101) serving the PWA and proxying `/api` to the API Service by its fully qualified name. `preStop` sleep 10 s.                                                                                                  |
| migrations                         | initContainer `migrate` in api and worker pods                            | Runs `node init-db.mjs`: forward-only migrations under an advisory lock, a bounded wait for PostgreSQL, and the optional demo seed under its own advisory lock.                                                                          |
| config                             | ConfigMap + Secret (or `existingSecret`)                                  | Secrets are never in values files. A config checksum annotation rolls pods when the config changes.                                                                                                                                      |
| local dependencies (kind/k3d only) | PostgreSQL and Kafka StatefulSets with PVCs; Redis Deployment             | `localDependencies.enabled: true` in `values-local.yaml`. Not a production data tier.                                                                                                                                                    |

Security context on every pod:

- `runAsNonRoot` with **numeric** `runAsUser`/`runAsGroup` (1000 for api and worker, 101 for web);
- seccomp `RuntimeDefault`;
- no privilege escalation;
- all capabilities dropped.

## Stateful dependencies: decision

- **Production (`values.yaml`):** PostgreSQL, Kafka and Redis are external, managed services. The chart deploys only
  the stateless tier and reads connection strings from an existing Secret.
  - Running databases and brokers in-cluster needs operators, backups, replication and upgrades.
  - That is a separate project, and pretending otherwise would be the "Kubernetes gives HA" fallacy.
- **Local (`values-local.yaml`):** single-replica in-cluster dependencies with PVCs, so the whole system can be
  exercised on kind.

## Run it

Requires Docker Desktop, plus `kind` 0.25.0, `helm` 3.16.3 and `kubectl`. The kind and helm binaries were verified
against their published SHA-256 checksums.

```powershell
kind create cluster --config deploy/kind/kind-config.yaml        # cluster "aisleforge", node v1.31.2
docker compose --profile app build                               # aisleforge/{api,worker,web}:dev
pnpm tsx tools/k8s/verify-kind.ts                                # import images, helm install, live checks
```

What `verify-kind.ts` does first:

- **Images:** it imports the locally built images into the node with `docker save` → `docker cp` → `ctr import`.
  - It does this only when the node's image digest differs from the local one, so a run never tests a stale image.
  - About 25 s per image, compared with 8–10 minutes for `kind load` through Windows pipes on this machine.
- **Namespace:** it starts from a clean `aisleforge` namespace.
  - Secrets are generated per run, and PostgreSQL only reads its password at initdb, so a leftover PVC could not be
    reused.

A manual install:

```powershell
helm upgrade --install af deploy/helm/aisleforge -n aisleforge --create-namespace `
  -f deploy/helm/aisleforge/values-local.yaml `
  --set secrets.values.POSTGRES_PASSWORD=… --set secrets.values.DATABASE_URL=postgres://aisleforge:…@af-postgres:5432/aisleforge `
  --set secrets.values.JWT_SECRET=… --set secrets.values.SEED_PASSWORD=… --set secrets.values.REDIS_URL=redis://af-redis:6379 `
  --wait --timeout 15m
kubectl -n aisleforge port-forward svc/af-web 8090:8080    # then http://localhost:8090
```

Validation without a cluster:

- `helm lint` passes.
- `kubeconform` 0.6.7 (`-strict`, Kubernetes 1.31 schemas) validates every rendered manifest.
- Both run in CI.

## Final validation on kind (Phase 10, 2026-11-23 18:30 UTC)

The fixed images (D-K5 fix, hardened runtime image) were deployed to a **new** cluster and passed **12/12**.
Evidence: `audit/test-results/phase9/kind-verify.run-2026-11-23T18-30-20-107Z.json`.

- **D-K5:** 0 worker SIGSEGVs across 3 fresh deployments. Before the fix, every fresh deployment had 1–4.
  - The only worker restart was a clean exit 1: the designed fail-fast start while Kafka was not ready yet.
- **Rolling update:** 141/141 requests OK in the accepted attempt.
  - The two earlier attempts each had **1 × 503 on `/health/ready`**, with `preStop` at 5 s and then 10 s.
  - 0 of 210 catalog requests failed across all three attempts.
  - **The cause is not determined**: the old pod that answered was already gone.
  - The verifier now records response bodies (`draining` vs `not_ready`) so the next occurrence can be attributed.

## First verification on kind (accepted run 2026-11-22 18:06 UTC)

Evidence: `audit/test-results/phase9/kind-verify.run-2026-11-22T18-06-10-485Z.json`. Index of every attempt:
`audit/test-results/phase9/README.md`.

| #   | Check (live cluster)                                                                                | Result                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Images present in the node (digest-checked)                                                         | PASS                                                                                               |
| 2   | `helm install` with local values, PVCs and generated secrets                                        | PASS (290 s, including PostgreSQL/Kafka start-up and image start)                                  |
| 3   | All workloads rolled out, startup and readiness probes passed                                       | PASS. **Worker restarted 4× with exit 139 (SIGSEGV) during start-up, see D-K5**                    |
| 4   | End-to-end through the web Service (nginx → API → PostgreSQL → outbox → Kafka → worker → pick task) | PASS, task created 1.4 s after the order                                                           |
| 5   | Picker claims and completes the task through `/sync`; order reaches `picked`                        | PASS (`applied`, `applied`)                                                                        |
| 6   | Worker pod deleted → replacement resumes consumption                                                | PASS, a new order's task created 5.3 s after the replacement was ready                             |
| 7   | Redis scaled to 0 → login and catalog still served; Redis restored                                  | PASS (815 ms, `X-Cache: MISS`, i.e. served from PostgreSQL)                                        |
| 8   | Rolling update under continuous traffic (`helm upgrade`, config change → new API pods)              | PASS: **256/256 requests OK** (health + authenticated catalog through nginx) during a 39 s rollout |
| 9   | `helm rollback` restores the previous configuration                                                 | PASS (history: install → upgrade → rollback to 1)                                                  |
| 10  | PostgreSQL pod deleted → data persists on its PVC                                                   | PASS (orders before = after)                                                                       |
| 11  | In-cluster backup (`pg_dump`) and restore into a separate database                                  | PASS (68.9 kB dump; orders/ledger 2/27 = 2/27)                                                     |
| 12  | Final pod state                                                                                     | All ready; 0 restarts on the current pods                                                          |

## Defects found only by deploying (all fixed and re-verified)

| Found    | Defect                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run 1    | `runAsNonRoot` + a **named** image user (`USER node`): the kubelet cannot verify non-root and refuses to start the container (`CreateContainerConfigError`) | Numeric `runAsUser`/`runAsGroup` in the pod security context                                                                                                                                                                                                                |
| run 2    | Migrate initContainers started before PostgreSQL accepted connections → `ECONNREFUSED` crash, recovered only by the restart backoff                         | `init-db` waits up to 90 s, for connection-class errors only                                                                                                                                                                                                                |
| run 2    | **Concurrent demo seeding race**: every replica's initContainer seeds at the same time; check-then-insert → `Balance already exists` → crash loop           | Seed serialized by an advisory lock. Regression test `tests/integration/seed-concurrency.test.ts` (5 rounds × 6 concurrent seeders) **fails without the lock** (negative control kept) and passes with it                                                                   |
| run 3    | nginx could not resolve `af-api`: its runtime resolver (needed so a replaced API IP is picked up, a Compose fix) ignores resolv.conf search domains         | The chart passes the fully qualified Service name (`af-api.<ns>.svc.<clusterDomain>`)                                                                                                                                                                                       |
| run 4    | The verifier's rolling-update check made only **one** request (a synchronous `helm` call blocked the traffic loop), so it proved nothing                    | Async helm, continuous traffic, minimum of 50 requests, failures logged per path                                                                                                                                                                                            |
| run 6    | 1 × 503 in 235 requests during a rolling update: a terminating API pod drains before kube-proxy drops it from the endpoints                                 | `preStop` sleep 10 s on api and web → 256/256 OK                                                                                                                                                                                                                            |
| runs 2–7 | **D-K5:** the worker crashes natively (exit 139, SIGSEGV) at every fresh deployment                                                                         | **Fixed 2026-11-23**: the root cause is an Admin offset fetch crashing inside librdkafka (gdb). Lag is now read through the consumers, and clients are released before exit. Fresh kind deployments: 0 SIGSEGV. See `docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md` |

## Limits of this verification

- **Topology:** a single-node kind cluster on a laptop. No multi-node scheduling, no node failure, no real Ingress
  controller (port-forward to the web Service instead), and no autoscaling.
- **Image registry:** images are imported locally. Pushing to a registry is a CI job that runs only when explicitly
  dispatched, and it was not run (no publishing without authorization).
- **API kill under load (E6):** only the rolling-update traffic test covers availability during a pod replacement.
  A deliberate API pod kill under load was not run.
