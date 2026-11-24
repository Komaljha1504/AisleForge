# Phase 0 — Review of the audit artifacts

Reviewed: `audit/RETAILFLOW_AUDIT.md`, `audit/load-tests/FAILURE_INJECTION_RUNBOOK.md`,
`audit/load-tests/k6/retailflow-load.js`, `audit/prototypes/**` (scripts and raw results). All audit evidence is
preserved unmodified. The only file added under `audit/` that the audit referenced but never created is
`audit/load-tests/invariants.sql`, plus new results under `audit/test-results/`.

## What each artifact is

| Artifact                                                | Classification                                         | Notes                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `audit/prototypes/inventory-concurrency/results/run2-*` | **Evidence** (measured, isolated prototype schema)     | Valid T1/T5 figures. Not a measurement of AisleForge                                   |
| `audit/prototypes/inventory-concurrency/results/run1-*` | Evidence with **known-invalid parts**                  | Run-1 T1 (cold pool) and T5 (3 s timeout) are invalid; the README says so              |
| `audit/prototypes/route-optimization/results/*`         | **Evidence** (measured, synthetic layout)              | Basis for Phase 5 comparisons                                                          |
| `audit/RETAILFLOW_AUDIT.md`                             | **Analysis** + measured evidence, labelled per finding | Pre-implementation; superseded where the build prompt makes Redis/Kubernetes mandatory |
| `audit/load-tests/k6/retailflow-load.js`                | **Template, never executed**                           | API contract it targets did not exist; contains defects (below)                        |
| `audit/load-tests/FAILURE_INJECTION_RUNBOOK.md`         | **Plan, never executed**                               | Contains defects (below)                                                               |

## Contradictions and gaps found

### k6 template (`retailflow-load.js`) — to be corrected in a new file in Phase 6, original kept

1. **409 counted as failure.** k6 marks every status ≥ 400 as `http_req_failed`, so out-of-stock (an expected
   business outcome) would breach the `rate<0.01` threshold. Needs `http.setResponseCallback(http.expectedStatuses(...))`.
2. **All orders from one principal** (`loadtest-customer`). Per-principal rate limiting (Phase 3/7) would throttle the
   entire test; idempotency and authorization would be exercised unrealistically.
3. **Reconnect-storm ops reference non-existent tasks** (`seeded-task-${__VU}`, `baseVersion: 1`), so every op would be
   rejected and only the rejection path is measured. Needs real seeded, leased tasks.
4. **`uuidv4` op ids** while the protocol specifies UUIDv7 (time-ordered).
5. **Remote jslib import** (`jslib.k6.io`) makes test runs depend on internet access; use built-in `crypto.randomUUID()`.
6. **Online scan endpoint vs sync endpoint** were modelled as two different write paths. Decision (ADR-004): online
   scanning goes through the same op-log + `/sync` path, so there is one conflict/idempotency implementation.
7. Summary output path is relative to the k6 working directory and the directory is not created.

### Failure-injection runbook

8. **E5 is garbled** ("`ALTER SYSTEM SET` nothing") and proposes `tc netem`, which is not dependable on Docker
   Desktop/WSL2. Replace with **Toxiproxy** (latency/timeout/reset toxics) between API/worker and PostgreSQL.
9. **I6 definition is wrong** ("processed_events count per consumer = outbox count for subscribed types"): it breaks
   with DLT-routed events, retention and consumer-specific eligibility. Corrected definition: no event has more than
   one business effect per consumer; DLT events are accounted for explicitly (Phase 2).
10. **I3 only reconciled `on_hand`.** Implemented I3 reconciles both `on_hand` and `reserved`, and requires exactly
    one opening movement per balance.

### Audit design sketches (§13.3 schema)

11. Idempotency was embedded in `orders` (`idempotency_key`, `request_hash`). The build requirements need a stored
    status + response body (so 409/422 outcomes replay identically) → separate `idempotency_keys` table.
12. `reservations` lacked `order_id`; the ledger lacked movement-shape constraints and append-only enforcement → added.
13. **Reservation TTL vs task lease conflict** was unspecified: a 30-minute reservation TTL would expire stock for a task
    leased for hours to an offline picker. Decision (ADR-004): claiming a task extends its reservations' `expires_at`
    to the lease expiry; the TTL sweep only releases stock that no valid lease protects.
14. **Short-pick inventory semantics** were unspecified. Decision (ADR-002): short-picked units leave `reserved` and
    `on_hand` via a separate `short_pick` ledger movement and trigger a recount.

### Scope changes vs the audit

15. The audit recommended postponing/making optional Redis and Kubernetes; the build requirements make both
    **mandatory** (introduced in Phases 7 and 9). The audit's sequencing (Compose first, measure before Redis) is kept.
16. Prototype throughput (e.g. T4 150 orders/s) was measured on a minimal schema without ledger, outbox, idempotency or
    order rows. **It is not comparable** to AisleForge's measurements (T4: 119 orders/s doing ~4× the writes).

## Environment facts (measured 2026-11-21)

- Windows 11, Intel i5-1135G7 (4C/8T), 7.7 GB RAM, 256 GB free disk.
- Node 24.11.1, pnpm 10.34.9 (installed in Phase 1), Python 3.12.10, Java 17, WSL2 2.5.9 with an Ubuntu distro.
- **Not installed: Docker, kubectl, kind/k3d, helm, k6.** Kafka, Redis, Compose, Toxiproxy and Kubernetes work is
  therefore BLOCKED until a container runtime exists (see `docs/IMPLEMENTATION_STATUS.md`).
- Workspace lives in a **OneDrive-synced folder**. `node_modules` (tens of thousands of files) inside a synced folder
  causes sync churn and can produce transient `EBUSY/EPERM` file locks. Not observed so far; recorded as a risk.
