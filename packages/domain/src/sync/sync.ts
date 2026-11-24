import { withTransaction, type PgClient, type PgPool } from '@aisleforge/database';
import { AppError, isAppError } from '@aisleforge/shared';
import type { DomainContext } from '../context';
import type { Principal } from '../identity/authorization';
import { applyPickConfirm, applyTaskComplete, OpRejected } from '../picking/taskOps';

/**
 * Offline-operation synchronization (ADR-004).
 *
 * One write path for online and offline picking: the device appends operations to its IndexedDB log and uploads them
 * here in `seq` order. Each operation runs in ITS OWN transaction (a rejected op never rolls back an applied one):
 *
 *   lock device row (serializes concurrent uploads from two tabs of the same device)
 *   → known (device_id, op_id)?           → `duplicate` with the ORIGINAL stored outcome (idempotent retry)
 *   → seq ≤ device.last_seq?              → `rejected: sequence_regression` (never applied out of order)
 *   → apply under a SAVEPOINT             → business rule violated? roll back to the savepoint, record `rejected`
 *   → record sync_ops row, advance last_seq, COMMIT
 *
 * An infrastructure failure (DB timeout, pool exhausted) stops the batch: that op and every later one get `retry`,
 * so the client resends them in order. Nothing is dropped and nothing is applied ahead of an earlier op.
 */
export type OpType = 'pick.confirm' | 'task.complete';

export interface SyncOpInput {
  opId: string;
  seq: number;
  type: OpType;
  taskId: string;
  payload: Record<string, unknown>;
  clientCreatedAt?: string | undefined;
}

export type SyncOpResult =
  | { opId: string; seq: number; status: 'applied'; result: Record<string, unknown> }
  | {
      opId: string;
      seq: number;
      status: 'duplicate';
      original: 'applied' | 'rejected';
      reason?: string;
      result?: unknown;
    }
  | { opId: string; seq: number; status: 'rejected'; reason: string; message: string }
  | { opId: string; seq: number; status: 'retry'; retryAfterSeconds: number };

interface DeviceRow {
  last_seq: number;
  first_user_id: string;
}

export async function syncOperations(
  ctx: DomainContext,
  p: Principal,
  req: { deviceId: string; userAgent: string | null; ops: SyncOpInput[]; correlationId: string },
): Promise<{ results: SyncOpResult[]; lastSeq: number }> {
  if (p.role !== 'picker' && p.role !== 'supervisor')
    throw new AppError('FORBIDDEN', 'Only store staff can synchronize picking operations');
  for (let i = 1; i < req.ops.length; i++)
    if (req.ops[i]!.seq <= req.ops[i - 1]!.seq)
      throw new AppError('VALIDATION_FAILED', 'Operations must be sent in strictly increasing seq order');

  const results: SyncOpResult[] = [];
  let lastSeq = 0;
  for (let i = 0; i < req.ops.length; i++) {
    const op = req.ops[i]!;
    try {
      const out = await withTransaction(
        ctx.pool,
        { label: 'sync.op', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS },
        (c) => applyOne(ctx, c, p, req, op),
      );
      results.push(out.result);
      lastSeq = out.lastSeq;
    } catch (e) {
      // Infrastructure failure: stop here; this op and all later ones must be resent, in order.
      const retryAfterSeconds = isAppError(e) ? (e.retryAfterSeconds ?? 2) : 2;
      if (isAppError(e) && !['DB_POOL_EXHAUSTED', 'DB_TIMEOUT', 'DEPENDENCY_UNAVAILABLE'].includes(e.code))
        throw e;
      for (const rest of req.ops.slice(i))
        results.push({ opId: rest.opId, seq: rest.seq, status: 'retry', retryAfterSeconds });
      break;
    }
  }
  return { results, lastSeq };
}

async function applyOne(
  ctx: DomainContext,
  c: PgClient,
  p: Principal,
  req: { deviceId: string; userAgent: string | null; correlationId: string },
  op: SyncOpInput,
): Promise<{ result: SyncOpResult; lastSeq: number }> {
  // Register / lock the device. A device belongs to whoever first synced from it; another employee on a shared
  // device is allowed (ops carry the authenticated user), and the last user is recorded.
  await c.query(
    `INSERT INTO devices (device_id, first_user_id, last_user_id, user_agent) VALUES ($1, $2, $2, $3)
     ON CONFLICT (device_id) DO NOTHING`,
    [req.deviceId, p.userId, req.userAgent],
  );
  const dev = (
    await c.query<DeviceRow>('SELECT last_seq, first_user_id FROM devices WHERE device_id = $1 FOR UPDATE', [
      req.deviceId,
    ])
  ).rows[0]!;

  const existing = await c.query<{
    status: 'applied' | 'rejected';
    reason: string | null;
    result: unknown;
    user_id: string;
  }>('SELECT status, reason, result, user_id FROM sync_ops WHERE device_id = $1 AND op_id = $2', [
    req.deviceId,
    op.opId,
  ]);
  const prev = existing.rows[0];
  if (prev) {
    if (prev.user_id !== p.userId)
      throw new AppError('FORBIDDEN', 'This operation was recorded for a different employee');
    return {
      result: {
        opId: op.opId,
        seq: op.seq,
        status: 'duplicate',
        original: prev.status,
        ...(prev.reason ? { reason: prev.reason } : {}),
        ...(prev.result ? { result: prev.result } : {}),
      },
      lastSeq: dev.last_seq,
    };
  }

  let status: 'applied' | 'rejected';
  let reason: string | null = null;
  let message = '';
  let result: Record<string, unknown> | null = null;
  if (op.seq <= dev.last_seq) {
    // Not persisted: its seq may already belong to another recorded op (UNIQUE (device_id, seq)). The client keeps
    // it visible as rejected; it is never applied out of order.
    return {
      result: {
        opId: op.opId,
        seq: op.seq,
        status: 'rejected',
        reason: 'sequence_regression',
        message: `seq ${op.seq} is not after the last synchronized seq ${dev.last_seq}`,
      },
      lastSeq: dev.last_seq,
    };
  }
  {
    await c.query('SAVEPOINT op');
    try {
      result =
        op.type === 'pick.confirm'
          ? await applyPickConfirm(
              ctx,
              c,
              p,
              {
                taskId: op.taskId,
                orderLineId: String(op.payload.orderLineId),
                scannedSku: String(op.payload.scannedSku),
                pickedQty: Number(op.payload.pickedQty),
              },
              req.correlationId,
            )
          : await applyTaskComplete(c, p, { taskId: op.taskId }, req.correlationId);
      status = 'applied';
      await c.query('RELEASE SAVEPOINT op');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT op');
      if (e instanceof OpRejected) {
        status = 'rejected';
        reason = e.reason;
        message = e.message;
      } else if (isAppError(e) && (e.code === 'VALIDATION_FAILED' || e.code === 'INVALID_STATE_TRANSITION')) {
        status = 'rejected';
        reason = e.code === 'VALIDATION_FAILED' ? 'invalid_operation' : 'invalid_state';
        message = e.message;
      } else {
        throw e; // infrastructure → retry
      }
    }
  }

  const storeRow = await c.query<{ store_id: number }>('SELECT store_id FROM pick_tasks WHERE id = $1', [
    op.taskId,
  ]);
  await c.query(
    `INSERT INTO sync_ops (device_id, op_id, seq, user_id, store_id, op_type, task_id, payload, status, reason, result,
                           client_created_at, review_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13)`,
    [
      req.deviceId,
      op.opId,
      op.seq,
      p.userId,
      storeRow.rows[0]?.store_id ?? p.storeId,
      op.type,
      op.taskId,
      JSON.stringify(op.payload),
      status,
      reason,
      result ? JSON.stringify(result) : null,
      op.clientCreatedAt ?? null,
      status === 'rejected' ? 'open' : null,
    ],
  );
  const newLast = Math.max(dev.last_seq, op.seq);
  await c.query(
    'UPDATE devices SET last_seq = $2, last_user_id = $3, last_sync_at = clock_timestamp() WHERE device_id = $1',
    [req.deviceId, newLast, p.userId],
  );
  return {
    result:
      status === 'applied'
        ? { opId: op.opId, seq: op.seq, status, result: result ?? {} }
        : { opId: op.opId, seq: op.seq, status, reason: reason!, message },
    lastSeq: newLast,
  };
}

// ---- supervisor review of rejected operations ------------------------------------------------------------------

export interface RejectionView {
  deviceId: string;
  opId: string;
  seq: number;
  userId: string;
  userName: string;
  storeId: number | null;
  type: string;
  taskId: string | null;
  orderId: string | null;
  payload: unknown;
  reason: string;
  receivedAt: string;
  clientCreatedAt: string | null;
  reviewStatus: 'open' | 'acknowledged' | 'recount_requested';
  reviewedBy: string | null;
  reviewNote: string | null;
}

export async function listRejections(
  pool: PgPool,
  p: Principal,
  q: { status: 'open' | 'resolved' | 'all'; limit: number; onlyUserId?: string },
): Promise<RejectionView[]> {
  const statusSql = { open: `s.review_status = 'open'`, resolved: `s.review_status <> 'open'`, all: 'TRUE' }[
    q.status
  ];
  const { rows } = await pool.query<{
    device_id: string;
    op_id: string;
    seq: number;
    user_id: string;
    user_name: string;
    store_id: number | null;
    op_type: string;
    task_id: string | null;
    order_id: string | null;
    payload: unknown;
    reason: string;
    received_at: Date;
    client_created_at: Date | null;
    review_status: RejectionView['reviewStatus'];
    reviewed_by: string | null;
    review_note: string | null;
  }>(
    `SELECT s.device_id, s.op_id, s.seq, s.user_id, u.display_name AS user_name, s.store_id, s.op_type, s.task_id,
            t.order_id, s.payload, s.reason, s.received_at, s.client_created_at, s.review_status, s.reviewed_by,
            s.review_note
       FROM sync_ops s JOIN users u ON u.id = s.user_id LEFT JOIN pick_tasks t ON t.id = s.task_id
      WHERE s.status = 'rejected' AND ($1::text = 'admin' OR s.store_id = $2::int) AND ${statusSql}
        AND ($4::uuid IS NULL OR s.user_id = $4::uuid)
      ORDER BY s.received_at DESC LIMIT $3`,
    [p.role, p.storeId, q.limit, q.onlyUserId ?? null],
  );
  return rows.map((r) => ({
    deviceId: r.device_id,
    opId: r.op_id,
    seq: r.seq,
    userId: r.user_id,
    userName: r.user_name,
    storeId: r.store_id,
    type: r.op_type,
    taskId: r.task_id,
    orderId: r.order_id,
    payload: r.payload,
    reason: r.reason,
    receivedAt: r.received_at.toISOString(),
    clientCreatedAt: r.client_created_at?.toISOString() ?? null,
    reviewStatus: r.review_status,
    reviewedBy: r.reviewed_by,
    reviewNote: r.review_note,
  }));
}

/** Own rejections (the picker sees why an offline action did not count). */
export async function listMyRejections(pool: PgPool, p: Principal, limit: number): Promise<RejectionView[]> {
  return listRejections(pool, p, { status: 'all', limit, onlyUserId: p.userId });
}

export async function resolveRejection(
  pool: PgPool,
  p: Principal,
  args: { deviceId: string; opId: string; resolution: 'acknowledged' | 'recount_requested'; note: string },
): Promise<void> {
  const r = await pool.query(
    `UPDATE sync_ops SET review_status = $3, reviewed_by = $4, reviewed_at = clock_timestamp(), review_note = $5
      WHERE device_id = $1 AND op_id = $2 AND status = 'rejected' AND review_status = 'open'
        AND ($6::text = 'admin' OR store_id = $7::int)`,
    [args.deviceId, args.opId, args.resolution, p.userId, args.note, p.role, p.storeId],
  );
  if (!r.rowCount) throw new AppError('NOT_FOUND', 'No open rejected operation with that id in your store');
}
