# Phase 9 evidence: Kubernetes (kind) + Helm

Cluster: kind 0.25.0, node `kindest/node:v1.31.2`, cluster `aisleforge`, on Docker Desktop (WSL2, VM capped at 4 GiB)
on a 7.7 GB Windows laptop. Driver: `tools/k8s/verify-kind.ts` (every check runs against the live cluster).
Every attempt is listed, including the failed ones.

| # | When (UTC) | Result | What it showed | Evidence |
| --- | --- | --- | --- | --- |
| 1 | 17:1x | stopped (no JSON) | Pods `CreateContainerConfigError`: `runAsNonRoot` with a **named** image user (`USER node`) cannot be verified by the kubelet. Fixed: numeric `runAsUser`/`runAsGroup` (1000 api/worker, 101 web). | this file |
| 2 | 17:25 | stopped (no JSON) | (a) migrate initContainers crashed with `ECONNREFUSED` (started before PostgreSQL) → bounded DB wait in `init-db`; (b) **concurrent demo seeding race** across replicas (`Balance already exists`) → advisory lock + regression test; (c) **worker SIGSEGV (exit 139)** while the fresh broker loaded `__consumer_offsets` (D-K5 on Linux) | `dk5-linux-sigsegv-20261122T1726Z/`, `seed-concurrency*.json`, `seed-negative-control-lock-disabled/` |
| 3 | 17:40 | **FAIL** at end-to-end | nginx: `af-api could not be resolved`. nginx's runtime resolver ignores resolv.conf search domains → chart passes the fully qualified Service name. Worker SIGSEGV again (exit 139). | `kind-verify.run-2026-11-22T17-40-15-697Z.json`, `dk5-linux-sigsegv-20261122T1741Z/` |
| 4 | 17:45 | PASS 12/12, **one check too weak** | The rolling-update step made only **1** request: the synchronous `helm` call blocked the event loop that was supposed to send traffic. Not counted as rolling-update evidence. Worker restarted 2× during install; exit codes lost (the pod was replaced by a later step) → the rollout step now records last terminations. | `kind-verify.run-2026-11-22T17-45-18-748Z.json` |
| 5 | 17:49 | FAIL (harness) | The new termination capture used a jsonpath with an embedded newline, which kubectl rejected. Harness error, not a cluster failure. Captured by hand from that deployment before rerunning: worker `restarts=1 last=139/Error` (D-K5, third occurrence). | `kind-verify.run-2026-11-22T17-49-28-994Z.json`, `dk5-linux-sigsegv-20261122T1749Z/` |
| 6 | 17:55 | **FAIL** at rolling update | The corrected rolling-update check (async helm, continuous traffic) found **1 × 503 in 235 requests**: a terminating API pod drains (readiness 503, listener closed) before kube-proxy removes it from the endpoints. Fixed with a `preStop` sleep (5 s) on api and web. | `kind-verify.run-2026-11-22T17-55-24-869Z.json` |
| **7** | **18:06** | **PASS 12/12** | Accepted run. Rolling update: **256/256 requests OK** (health + authenticated catalog through nginx, rollout 39 s). Worker crashed **4×** with exit 139 during install (D-K5); the replacement started later against a settled broker had 0 restarts. | `kind-verify.run-2026-11-22T18-06-10-485Z.json` |

## Phase 10 final run (2026-11-23, fixed images: D-K5 fix + hardened runtime image, fresh cluster)

| # | When (UTC) | Result | What it showed | Evidence |
| --- | --- | --- | --- | --- |
| 8 | 18:23 | **FAIL** at rolling update | **1 × 503 on `/health/ready`** in 137 requests (`preStop` 5 s); 68/68 catalog OK. Worker: **0 restarts** on a fresh deployment (D-K5 fixed). | `kind-verify.run-2026-11-23T18-23-10-219Z.json` |
| 9 | 18:26 | **FAIL** at rolling update | `preStop` raised to 10 s: again **1 × 503 on `/health/ready`** in 145; 72/72 catalog OK. Worker restarted once with **exit 1** (designed fail-fast start, clean exit), not 139. | `kind-verify.run-2026-11-23T18-26-10-510Z.json` |
| **10** | **18:30** | **PASS 12/12** | Rolling update 141/141 OK. Worker 0 restarts. The verifier now records 503 bodies. The cause of runs 8–9's 503 is **not determined** (the answering old pod was gone). | `kind-verify.run-2026-11-23T18-30-20-107Z.json` |

Stdout of runs 8–10: `audit/test-results/phase10/final-20261123T165033Z/kind-verify*.txt`.
