import { withTransaction, type PgClient, type PgPool } from '@aisleforge/database';
import { AppError } from '@aisleforge/shared';
import type { DomainContext } from '../context';
import type { Principal } from '../identity/authorization';
import { enqueueEvents } from '../outbox';
import { advanceOrderIfFullyPicked, confirmPickInTx } from '../inventory/reservations';

/**
 * Pick-task queries and lease operations (Phase 4, ADR-004).
 * Store isolation is part of every query: staff only ever see tasks of their own store; admins see all.
 * A task outside the caller's scope is indistinguishable from a missing one (404).
 */
const taskScope = (role: number, store: number) =>
  `($${role}::text = 'admin' OR t.store_id = $${store}::int)`;

export interface TaskLine {
  orderLineId: string;
  lineNo: number;
  sku: string;
  productName: string;
  zone: string;
  qty: number;
  pickedQty: number;
  shortQty: number;
  reservationId: string | null;
  reservationStatus: string | null;
  location: { aisle: number; pos: number } | null;
}

export interface TaskView {
  id: string;
  orderId: string;
  storeId: number;
  status: 'open' | 'claimed' | 'completed' | 'cancelled';
  version: number;
  assignedTo: string | null;
  assignedToName: string | null;
  leaseExpiresAt: string | null;
  routeStatus: string;
  route: unknown;
  orderStatus: string;
  createdAt: string;
  completedAt: string | null;
  lines?: TaskLine[];
}

interface TaskRow {
  id: string;
  order_id: string;
  store_id: number;
  status: TaskView['status'];
  version: number;
  assigned_to: string | null;
  assigned_name: string | null;
  lease_expires_at: Date | null;
  route_status: string;
  route: unknown;
  order_status: string;
  created_at: Date;
  completed_at: Date | null;
  lines?: TaskLine[];
}

const TASK_COLUMNS = `t.id, t.order_id, t.store_id, t.status, t.version, t.assigned_to, u.display_name AS assigned_name,
  t.lease_expires_at, t.route_status, t.route, o.status AS order_status, t.created_at, t.completed_at`;

const toView = (r: TaskRow): TaskView => ({
  id: r.id,
  orderId: r.order_id,
  storeId: r.store_id,
  status: r.status,
  version: r.version,
  assignedTo: r.assigned_to,
  assignedToName: r.assigned_name,
  leaseExpiresAt: r.lease_expires_at?.toISOString() ?? null,
  routeStatus: r.route_status,
  route: r.route,
  orderStatus: r.order_status,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
  ...(r.lines ? { lines: r.lines } : {}),
});

export type TaskListScope = 'available' | 'mine' | 'active' | 'all';

/**
 * available: open tasks + tasks whose lease has expired (claimable)  ·  mine: tasks claimed by the caller
 * active: open + claimed (supervisor overview)  ·  all: everything incl. completed/cancelled (most recent first)
 */
export async function listPickTasks(
  pool: PgPool,
  p: Principal,
  q: { scope: TaskListScope; limit: number },
): Promise<TaskView[]> {
  // Every parameter must be referenced (PostgreSQL cannot type an unused one), so $3 is the user id in all scopes.
  const filter: Record<TaskListScope, string> = {
    available: `(t.status = 'open' OR (t.status = 'claimed' AND t.lease_expires_at < now() AND t.assigned_to <> $3::uuid))`,
    mine: `(t.status = 'claimed' AND t.assigned_to = $3::uuid)`,
    active: `(t.status IN ('open', 'claimed') AND $3::uuid IS NOT NULL)`,
    all: '($3::uuid IS NOT NULL)',
  };
  const order = q.scope === 'all' ? 't.created_at DESC, t.id DESC' : 't.created_at ASC, t.id ASC';
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
       FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.assigned_to
      WHERE ${taskScope(1, 2)} AND ${filter[q.scope]}
      ORDER BY ${order} LIMIT $4`,
    [p.role, p.storeId, p.userId, q.limit],
  );
  return rows.map(toView);
}

export async function getPickTask(pool: PgPool | PgClient, p: Principal, taskId: string): Promise<TaskView> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS},
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'orderLineId', l.id, 'lineNo', l.line_no, 'sku', l.sku, 'productName', pr.name,
                'zone', pr.temperature_zone, 'qty', l.qty, 'pickedQty', l.picked_qty, 'shortQty', l.short_qty,
                'reservationId', r.id, 'reservationStatus', r.status,
                'location', CASE WHEN s.sku IS NULL THEN NULL ELSE jsonb_build_object('aisle', s.aisle, 'pos', s.pos) END
              ) ORDER BY l.line_no)
              FROM order_lines l
              JOIN products pr ON pr.sku = l.sku
              LEFT JOIN reservations r ON r.order_line_id = l.id
              LEFT JOIN sku_locations s ON s.store_id = t.store_id AND s.sku = l.sku
             WHERE l.order_id = t.order_id), '[]'::jsonb) AS lines
       FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.id = $3 AND ${taskScope(1, 2)}`,
    [p.role, p.storeId, taskId],
  );
  const r = rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Pick task not found');
  return toView(r);
}

/**
 * Claims (or renews) a task lease. Allowed when the task is open, already leased to the caller, or its lease
 * expired (another picker abandoned it). While leased, the order's reservations are kept alive past the lease end
 * so the expiry sweeper cannot release stock under an active picker. Claiming requires the server (online).
 */
export async function claimPickTask(ctx: DomainContext, p: Principal, taskId: string): Promise<TaskView> {
  if (p.role !== 'picker' && p.role !== 'supervisor')
    throw new AppError('FORBIDDEN', 'Only store staff can claim pick tasks');
  return withTransaction(
    ctx.pool,
    { label: 'pick_tasks.claim', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS },
    async (c) => {
      const upd = await c.query<{ id: string; order_id: string; lease_expires_at: Date }>(
        `UPDATE pick_tasks t
          SET status = 'claimed', assigned_to = $2, version = version + 1, updated_at = clock_timestamp(),
              lease_expires_at = clock_timestamp() + make_interval(mins => $4)
        WHERE t.id = $1 AND t.store_id = $3
          AND (t.status = 'open' OR (t.status = 'claimed' AND (t.assigned_to = $2 OR t.lease_expires_at < now())))
        RETURNING t.id, t.order_id, t.lease_expires_at`,
        [taskId, p.userId, p.storeId, ctx.config.TASK_LEASE_MINUTES],
      );
      const t = upd.rows[0];
      if (!t) {
        const cur = await c.query<{ status: string; assigned_to: string | null }>(
          'SELECT status, assigned_to FROM pick_tasks WHERE id = $1 AND store_id = $2',
          [taskId, p.storeId],
        );
        const row = cur.rows[0];
        if (!row) throw new AppError('NOT_FOUND', 'Pick task not found');
        if (row.status === 'claimed')
          throw new AppError('CONFLICT', 'This task is being picked by someone else', {
            details: { reason: 'claimed_by_other' },
          });
        throw new AppError('INVALID_STATE_TRANSITION', `Task is ${row.status}`, {
          details: { reason: row.status },
        });
      }
      // Keep the stock reserved while the picker works (lock order: reservations → orders, as in cancelOrder).
      await c.query(
        `UPDATE reservations SET expires_at = GREATEST(expires_at, $2::timestamptz + make_interval(mins => $3)),
              updated_at = now()
        WHERE order_id = $1 AND status = 'active'`,
        [t.order_id, t.lease_expires_at, ctx.config.LEASE_RESERVATION_GRACE_MINUTES],
      );
      await c.query(
        `UPDATE orders SET status = 'picking', version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'reserved'`,
        [t.order_id],
      );
      return getPickTask(c, p, taskId);
    },
  );
}

/** Gives a task back: by its picker, or by a supervisor/admin (reassignment). */
export async function releasePickTask(ctx: DomainContext, p: Principal, taskId: string): Promise<TaskView> {
  return withTransaction(ctx.pool, { label: 'pick_tasks.release' }, async (c) => {
    const supervisorish = p.role === 'supervisor' || p.role === 'admin';
    const upd = await c.query(
      `UPDATE pick_tasks t SET status = 'open', assigned_to = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = clock_timestamp()
        WHERE t.id = $1 AND ${taskScope(2, 3)} AND t.status = 'claimed' AND ($4::boolean OR t.assigned_to = $5)`,
      [taskId, p.role, p.storeId, supervisorish, p.userId],
    );
    if (!upd.rowCount) {
      await getPickTask(c, p, taskId); // 404 if out of scope
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        'Only a claimed task can be released by its picker or a supervisor',
      );
    }
    return getPickTask(c, p, taskId);
  });
}

// ---- operations applied by /sync (each runs inside the caller's transaction) -------------------------------------

/** Business rejection of an offline operation: recorded, shown to the picker and to supervisors. Never thrown away. */
export class OpRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpRejected';
  }
}

interface LockedTask {
  id: string;
  order_id: string;
  store_id: number;
  status: string;
  assigned_to: string | null;
}

async function lockTaskForOp(c: PgClient, p: Principal, taskId: string): Promise<LockedTask> {
  const { rows } = await c.query<LockedTask>(
    `SELECT t.id, t.order_id, t.store_id, t.status, t.assigned_to FROM pick_tasks t
      WHERE t.id = $1 AND ${taskScope(2, 3)} FOR UPDATE`,
    [taskId, p.role, p.storeId],
  );
  const t = rows[0];
  if (!t) throw new OpRejected('task_not_found', 'Pick task not found');
  if (t.status === 'cancelled') throw new OpRejected('task_cancelled', 'The order was cancelled');
  if (t.assigned_to !== p.userId)
    throw new OpRejected(
      t.status === 'completed' ? 'task_completed_by_other' : 'task_not_assigned_to_you',
      'This task is no longer assigned to you',
    );
  return t;
}

export async function applyPickConfirm(
  ctx: { config: DomainContext['config'] },
  c: PgClient,
  p: Principal,
  op: { taskId: string; orderLineId: string; scannedSku: string; pickedQty: number },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const t = await lockTaskForOp(c, p, op.taskId);
  if (t.status === 'completed')
    throw new OpRejected('task_already_completed', 'The task is already completed');
  const line = await c.query<{
    sku: string;
    qty: number;
    reservation_id: string | null;
    res_status: string | null;
  }>(
    `SELECT l.sku, l.qty, r.id AS reservation_id, r.status AS res_status
       FROM order_lines l LEFT JOIN reservations r ON r.order_line_id = l.id
      WHERE l.id = $1 AND l.order_id = $2`,
    [op.orderLineId, t.order_id],
  );
  const l = line.rows[0];
  if (!l) throw new OpRejected('line_not_in_task', 'That item is not part of this task');
  if (op.scannedSku !== l.sku)
    throw new OpRejected('wrong_item_scanned', `Scanned ${op.scannedSku}, expected ${l.sku}`);
  if (op.pickedQty > l.qty) throw new OpRejected('quantity_exceeds_order', `At most ${l.qty} can be picked`);
  if (!l.reservation_id || l.res_status !== 'active')
    throw new OpRejected(
      l.res_status === 'picked' ? 'line_already_picked' : `reservation_${l.res_status ?? 'missing'}`,
      l.res_status === 'picked'
        ? 'This line was already picked'
        : 'The stock for this line is no longer reserved',
    );
  const out = await confirmPickInTx(
    c,
    { reservationId: l.reservation_id, pickedQty: op.pickedQty },
    { actorId: p.userId, correlationId },
  );
  if (!out.transitioned) throw new OpRejected('line_already_picked', 'This line was already picked');
  return { pickedQty: out.pickedQty, shortQty: out.shortQty };
}

export async function applyTaskComplete(
  c: PgClient,
  p: Principal,
  op: { taskId: string },
  correlationId: string,
): Promise<Record<string, unknown>> {
  const t = await lockTaskForOp(c, p, op.taskId);
  if (t.status === 'completed') return { alreadyCompleted: true };
  const open = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reservations WHERE order_id = $1 AND status = 'active'`,
    [t.order_id],
  );
  if (open.rows[0]!.n > 0)
    throw new OpRejected('lines_outstanding', `${open.rows[0]!.n} line(s) are not picked yet`);
  await c.query(
    `UPDATE pick_tasks SET status = 'completed', lease_expires_at = NULL, version = version + 1,
            completed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
    [t.id],
  );
  // If the last line was closed by expiry rather than a pick, the order has not advanced yet.
  const ev = await advanceOrderIfFullyPicked(c, t.order_id, { actorId: p.userId, correlationId });
  if (ev) await enqueueEvents(c, [ev]);
  return { completed: true };
}
