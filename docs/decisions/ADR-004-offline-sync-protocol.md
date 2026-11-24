# ADR-004 — Offline-first picking and synchronization protocol

**Status:** Implemented and tested in Phase 4 (2026-11-22). Server: `packages/domain/src/sync/sync.ts`,
`picking/taskOps.ts`, migration 0004. Client: `apps/web/src/offline/*`. Tests:
`tests/integration/picking-sync.test.ts` (8) and the Playwright suites `tests/e2e/{auth,offline,ui}.spec.ts` (8).

## Revisions made during implementation (2026-11-22)

1. **Expired lease, nobody else claimed → the op is still applied.**
   - This deliberately deviates from "apply if the lease is valid": rejecting would create supervisor work without
     preventing any conflict.
   - The safety conditions are unchanged: the task must still be assigned to this picker and the reservation must be
     active.
   - A task re-claimed by someone else → `rejected: task_not_assigned_to_you` (tested in the browser).
2. **Lease length:** 240 min (`TASK_LEASE_MINUTES`). Reservations are extended to the lease end plus 10 min while
   leased. Supervisors can release abandoned tasks.
3. **No generic DEPENDENCY_REJECTED.** Each op is validated against the current server state. `task.complete` is
   rejected with `lines_outstanding` while lines remain open. Blanket dependency rejection would also reject a
   legitimate rescan after a wrong-item scan.
4. **Sequence regression** (`seq` not above the device's high-water mark) is rejected and **not persisted**, since
   its seq may belong to an already-recorded op. It is never applied out of order.
5. **Shared-device sign-out while offline (defect found by the e2e test, fixed).**
   - The server logout could not be sent while offline, so the refresh cookie stayed valid. The next person to open
     the app online was silently signed in as the previous employee.
   - Now sign-out always ends the session on the device, through a local marker that stops automatic session
     restores. The owed logout is sent as soon as the network returns, revoking that device's refresh-token family.
   - Verified in Chromium.
6. **Cycle-count observations** (listed above) are **not implemented**: they are not in the Phase 4 feature scope.
   Short picks are recorded as `short_pick` ledger movements. A short pick that can no longer be applied becomes a
   rejected op with a "recount requested" review outcome.

## Operation log (device, IndexedDB via `idb`)

`{opId: UUIDv7, deviceId, employeeId, seq (per device, monotonic), taskId, type, payload, baseVersion, clientTime,
status}`. The UI state change and the op append happen in **one IndexedDB transaction**. If the append fails (quota,
eviction), the action is **blocked visibly**; an operation is never silently dropped. `navigator.storage.persist()`
is requested; only assigned-task data is cached.

## One write path

Online and offline scans both append to the op log and flow through `POST /api/v1/sync` (one in-flight batch per
device; Web Locks across tabs with a single-tab fallback). There is no separate "online scan" endpoint with different
idempotency or conflict semantics.

## Server processing

Each op is processed in its own short transaction, in `seq` order per device:
`INSERT sync_ops(device_id, op_id, …) ON CONFLICT` → return the stored result (`duplicate`) → validate → apply →
ledger/outbox → store the result. Results: `applied | duplicate | rejected(reason) | retry(retryAfter)`. The client
deletes an op only after receiving its result. Load shedding: `429` + jittered `Retry-After`. The sync pool is a
separate bulkhead from the order pool.

## Conflict rules (no last-write-wins; device clocks never decide)

| Op                                                    | Offline?          | Rule                                                                                                                               |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pick scan on own **leased** task                      | yes               | Apply if the lease is valid and the reservation is active, else `rejected: LEASE_EXPIRED / RESERVATION_CLOSED` → supervisor review |
| Short pick                                            | yes               | Always accepted as an observation → `short_pick` movement + recount task                                                           |
| Cycle-count observation                               | yes (observation) | Stored with `baseVersion`. If the balance changed since, flagged for reconciliation; never overwrites                              |
| Complete task                                         | yes               | Valid only when every line is resolved                                                                                             |
| Claim task, reserve stock, cancel order, substitution | **no**            | Server-confirmed only                                                                                                              |

**Leases.** Claiming a task creates a lease (e.g. 4 h) and **extends the task's reservations' `expires_at` to the
lease expiry**. This resolves the TTL-vs-lease conflict found in Phase 0. Ops after a rejected op on the same task
return `DEPENDENCY_REJECTED`.

**Identity.** Ops are bound to the `employeeId` that created them. A different employee logging in on a shared device
cannot upload them as themselves. Pending ops are held until the original employee re-authenticates. Per-user cached
data is cleared on logout.

The Service Worker caches only the static app shell, never authenticated API responses. Sync triggers: `online` event,
app foreground, explicit action, and a jittered timer. Background Sync is optional and never the only trigger.
