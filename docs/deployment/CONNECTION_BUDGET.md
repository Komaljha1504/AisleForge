# PostgreSQL connection budget

Audit T5 measured that `replicas × pool > max_connections` produces hard `53300 too many clients` failures. The budget
below is enforced by configuration (`packages/shared/src/config.ts`) and must be updated whenever replica counts change.

Every pool has a non-zero `connectionTimeoutMillis` (default 2000 ms). Acquire timeout → `503 DB_POOL_EXHAUSTED`
with a jittered `Retry-After`. Statement timeout 5 s, lock timeout 2 s, idle-in-transaction timeout 10 s.

| Process                         | Pools (max each)                      | Per process | Instances (Compose) | Subtotal |
| ------------------------------- | ------------------------------------- | ----------- | ------------------- | -------- |
| api                             | orders 10, sync 5                     | 15          | 2                   | 30       |
| worker                          | worker 5 + 1 publisher-leader session | 6           | 1                   | 6        |
| migrations / invariants / admin | ad-hoc                                | —           | —                   | 5        |
| **Total**                       |                                       |             |                     | **41**   |

PostgreSQL `max_connections = 100` (3 reserved for superuser) → headroom **56**. Kubernetes HPA `maxReplicas` for the
API must satisfy `maxReplicas × 15 + 11 ≤ 80` → **≤ 4 replicas** without a pooler (Phase 9 records the chosen value).
