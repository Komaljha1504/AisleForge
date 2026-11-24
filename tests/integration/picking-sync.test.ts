/**
 * Phase 4 server side, over real HTTP against real PostgreSQL: pick-task leases, the idempotent offline-sync
 * endpoint (applied / duplicate / rejected / sequence regression), conflict rules, supervisor review, store
 * isolation, load shedding and invariants I1–I7. Pick tasks are created with the same domain function the Kafka
 * consumer uses (Kafka itself is covered by tests/kafka/).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkInvariants, withTransaction } from '@aisleforge/database';
import { createPickTask, placeOrder, planTaskForOrder } from '@aisleforge/domain';
import { newId } from '@aisleforge/shared';
import { bearer, buildApi, login, seedUser, type Session, type TestApi } from '../support/api';
import {
  databaseUrl,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';

const pool = makePool(10);
const ctx = makeCtx(pool);
let api: TestApi;
let picker1: Session;
let picker2: Session;
let pickerStore2: Session;
let supervisor: Session;
let customer: Session;
let customerIds: string[] = [];
const evidence: Record<string, unknown> = {};
const device1 = newId();
const device2 = newId();

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStore(pool, 2);
  await seedStock(ctx, 1, { 'PS-A': 100, 'PS-B': 100, 'PS-C': 100 });
  await seedStock(ctx, 2, { 'PS-A': 100 });
  await pool.query(`INSERT INTO store_layouts (store_id, layout) VALUES (1, $1::jsonb)`, [
    JSON.stringify({
      id: 's1',
      aisles: 4,
      aisleLength: 20,
      aisleSpacing: 3,
      crossAisles: [0, 20],
      entry: { aisle: 0, pos: 0 },
      exit: { aisle: 0, pos: 0 },
    }),
  ]);
  await pool.query(
    `INSERT INTO sku_locations (store_id, sku, aisle, pos) VALUES (1,'PS-A',1,5),(1,'PS-B',2,15),(1,'PS-C',3,8)`,
  );
  await seedUser(pool, { email: 'p1@s1.test', role: 'picker', storeId: 1 });
  await seedUser(pool, { email: 'p2@s1.test', role: 'picker', storeId: 1 });
  await seedUser(pool, { email: 'p@s2.test', role: 'picker', storeId: 2 });
  await seedUser(pool, { email: 'sup@s1.test', role: 'supervisor', storeId: 1 });
  await seedUser(pool, { email: 'cust@x.test', role: 'customer' });
  customerIds = await seedCustomers(pool, 5);
  api = buildApi({ orders: pool, sync: pool }, { SYNC_MAX_REQUESTS: '40', SYNC_WINDOW_SECONDS: '60' });
  [picker1, picker2, pickerStore2, supervisor, customer] = await Promise.all([
    login(api.app, 'p1@s1.test'),
    login(api.app, 'p2@s1.test'),
    login(api.app, 'p@s2.test'),
    login(api.app, 'sup@s1.test'),
    login(api.app, 'cust@x.test'),
  ]);
});
afterAll(async () => {
  writeEvidence('phase4', 'picking-sync-server', evidence);
  await pool.end();
});

/** An order + its pick task, created exactly as the order-workflow consumer would. */
async function newTask(storeId: number, lines: { sku: string; qty: number }[]) {
  const out = await placeOrder(
    ctx,
    { principalId: customerIds[0]!, idempotencyKey: `ps-${newId()}`, storeId, lines },
    { actorId: null, correlationId: 'ps' },
  );
  const orderId = out.orderId!;
  const planned = await planTaskForOrder(pool, orderId, storeId);
  const task = await withTransaction(pool, { label: 'test.create_task' }, (c) =>
    createPickTask(c, { orderId, storeId, planned, correlationId: 'ps', sourceEventId: newId() }),
  );
  const lineRows = await pool.query<{ id: string; sku: string; qty: number }>(
    'SELECT id, sku, qty FROM order_lines WHERE order_id = $1 ORDER BY line_no',
    [orderId],
  );
  return { taskId: task!.id, orderId, lines: lineRows.rows };
}

let seq = 0;
const pickOp = (taskId: string, line: { id: string; sku: string }, qty: number, sku = line.sku) => ({
  opId: newId(),
  seq: ++seq,
  type: 'pick.confirm' as const,
  taskId,
  payload: { orderLineId: line.id, scannedSku: sku, pickedQty: qty },
});
const completeOp = (taskId: string) => ({
  opId: newId(),
  seq: ++seq,
  type: 'task.complete' as const,
  taskId,
  payload: {},
});
const sync = (s: Session, deviceId: string, ops: unknown[]) =>
  request(api.app).post('/api/v1/sync').set(bearer(s)).send({ deviceId, ops });

describe('pick tasks and leases', () => {
  it('pickers see only their store; claiming leases the task and keeps its reservations alive', async () => {
    const t = await newTask(1, [
      { sku: 'PS-A', qty: 2 },
      { sku: 'PS-B', qty: 1 },
    ]);
    const t2 = await newTask(2, [{ sku: 'PS-A', qty: 1 }]);
    const list = await request(api.app).get('/api/v1/pick-tasks?scope=available').set(bearer(picker1));
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((x: { id: string }) => x.id)).toContain(t.taskId);
    expect(list.body.tasks.map((x: { id: string }) => x.id)).not.toContain(t2.taskId);
    expect((await request(api.app).get(`/api/v1/pick-tasks/${t2.taskId}`).set(bearer(picker1))).status).toBe(
      404,
    );
    expect((await request(api.app).get('/api/v1/pick-tasks').set(bearer(customer))).status).toBe(403);

    const claim = await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1));
    expect(claim.status).toBe(200);
    expect(claim.body.task.status).toBe('claimed');
    expect(claim.body.task.orderStatus).toBe('picking');
    expect(claim.body.task.lines).toHaveLength(2);
    expect(claim.body.task.route.stops.length).toBe(2);
    const lease = new Date(claim.body.task.leaseExpiresAt).getTime();
    expect(lease - Date.now()).toBeGreaterThan(239 * 60_000); // 240 min lease (ADR-004)
    const res = await pool.query<{ min: Date }>(
      `SELECT min(expires_at) AS min FROM reservations WHERE order_id = $1 AND status = 'active'`,
      [t.orderId],
    );
    expect(res.rows[0]!.min.getTime()).toBeGreaterThanOrEqual(lease + 9 * 60_000); // lease + grace
    // Another picker cannot take a live lease.
    const other = await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker2));
    expect(other.status).toBe(409);
    expect(other.body.error.details.reason).toBe('claimed_by_other');
    // Mine
    const mine = await request(api.app).get('/api/v1/pick-tasks?scope=mine').set(bearer(picker1));
    expect(mine.body.tasks.map((x: { id: string }) => x.id)).toEqual([t.taskId]);
  });
});

describe('offline synchronization', () => {
  it('applies picks, completes the task, and a retried upload returns the ORIGINAL outcomes as duplicates', async () => {
    const t = await newTask(1, [
      { sku: 'PS-A', qty: 2 },
      { sku: 'PS-C', qty: 3 },
    ]);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1)).expect(200);
    const ops = [pickOp(t.taskId, t.lines[0]!, 2), pickOp(t.taskId, t.lines[1]!, 1), completeOp(t.taskId)]; // short pick on line 2
    const first = await sync(picker1, device1, ops);
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { status: string }) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(first.body.results[1].result).toEqual({ pickedQty: 1, shortQty: 2 });
    const again = await sync(picker1, device1, ops); // e.g. the response was lost and the device resends
    expect(
      again.body.results.map((r: { status: string; original: string }) => [r.status, r.original]),
    ).toEqual([
      ['duplicate', 'applied'],
      ['duplicate', 'applied'],
      ['duplicate', 'applied'],
    ]);
    const task = await request(api.app).get(`/api/v1/pick-tasks/${t.taskId}`).set(bearer(picker1));
    expect(task.body.task.status).toBe('completed');
    expect(task.body.task.orderStatus).toBe('picked');
    const ledger = await pool.query<{ movement: string; n: number }>(
      `SELECT l.movement::text, count(*)::int AS n FROM inventory_ledger l JOIN reservations r ON r.id::text = l.source_id
        WHERE r.order_id = $1 AND l.movement IN ('pick', 'short_pick') GROUP BY 1 ORDER BY 1`,
      [t.orderId],
    );
    expect(ledger.rows).toEqual([
      { movement: 'pick', n: 2 },
      { movement: 'short_pick', n: 1 },
    ]);
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.picked'`,
      [t.orderId],
    );
    expect(events.rows).toHaveLength(1);
    evidence.applyAndReplay = {
      first: first.body.results.map((r: { status: string }) => r.status),
      replay: 'duplicate×3',
    };
  });

  it('two tabs uploading the same queue concurrently apply each operation exactly once', async () => {
    const t = await newTask(1, [
      { sku: 'PS-B', qty: 1 },
      { sku: 'PS-C', qty: 1 },
    ]);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1)).expect(200);
    const ops = [pickOp(t.taskId, t.lines[0]!, 1), pickOp(t.taskId, t.lines[1]!, 1)];
    const [a, b] = await Promise.all([sync(picker1, device1, ops), sync(picker1, device1, ops)]);
    const statuses = [...a.body.results, ...b.body.results].map((r: { status: string }) => r.status).sort();
    expect(statuses).toEqual(['applied', 'applied', 'duplicate', 'duplicate']);
    const applied = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sync_ops WHERE task_id = $1 AND status = 'applied'`,
      [t.taskId],
    );
    expect(applied.rows[0]!.n).toBe(2);
  });

  it('business conflicts are REJECTED with a reason and kept for supervisor review (never dropped)', async () => {
    const t = await newTask(1, [
      { sku: 'PS-A', qty: 1 },
      { sku: 'PS-B', qty: 1 },
    ]);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1)).expect(200);
    const wrong = pickOp(t.taskId, t.lines[0]!, 1, 'PS-C');
    const early = completeOp(t.taskId);
    const r = await sync(picker1, device1, [wrong, early]);
    expect(r.body.results.map((x: { status: string; reason: string }) => [x.status, x.reason])).toEqual([
      ['rejected', 'wrong_item_scanned'],
      ['rejected', 'lines_outstanding'],
    ]);
    // Reassignment: supervisor releases, picker 2 claims; picker 1's offline pick is then rejected.
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/release`).set(bearer(supervisor)).expect(200);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker2)).expect(200);
    const stale = await sync(picker1, device1, [pickOp(t.taskId, t.lines[0]!, 1)]);
    expect(stale.body.results[0]).toMatchObject({ status: 'rejected', reason: 'task_not_assigned_to_you' });
    // The picker sees their rejections; the store's supervisor reviews them.
    const mine = await request(api.app).get('/api/v1/sync/rejections/mine').set(bearer(picker1));
    expect(mine.body.rejections.length).toBeGreaterThanOrEqual(3);
    const queue = await request(api.app).get('/api/v1/sync/rejections?status=open').set(bearer(supervisor));
    expect(queue.status).toBe(200);
    const item = queue.body.rejections.find((x: { reason: string }) => x.reason === 'wrong_item_scanned');
    expect(item).toBeTruthy();
    expect((await request(api.app).get('/api/v1/sync/rejections').set(bearer(picker1))).status).toBe(403);
    const resolve = await request(api.app)
      .post(`/api/v1/sync/rejections/${item.deviceId}/${item.opId}/resolve`)
      .set(bearer(supervisor))
      .send({ resolution: 'recount_requested', note: 'Bin PS-A may be mislabelled' });
    expect(resolve.status).toBe(204);
    const resolved = await request(api.app)
      .get('/api/v1/sync/rejections?status=resolved')
      .set(bearer(supervisor));
    expect(resolved.body.rejections.some((x: { opId: string }) => x.opId === item.opId)).toBe(true);
  });

  it('an expired lease is still honoured when nobody else claimed the task (ADR-004 revision)', async () => {
    const t = await newTask(1, [{ sku: 'PS-C', qty: 1 }]);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1)).expect(200);
    await pool.query(`UPDATE pick_tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      t.taskId,
    ]);
    const r = await sync(picker1, device1, [pickOp(t.taskId, t.lines[0]!, 1)]);
    expect(r.body.results[0].status).toBe('applied');
  });

  it('rejects an op whose seq is not after the device high-water mark, and other stores tasks', async () => {
    const t = await newTask(1, [{ sku: 'PS-A', qty: 1 }]);
    await request(api.app).post(`/api/v1/pick-tasks/${t.taskId}/claim`).set(bearer(picker1)).expect(200);
    const regress = { ...pickOp(t.taskId, t.lines[0]!, 1), seq: 1 };
    const r = await sync(picker1, device1, [regress]);
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', reason: 'sequence_regression' });
    const other = await sync(pickerStore2, device2, [{ ...pickOp(t.taskId, t.lines[0]!, 1), seq: 1 }]);
    expect(other.body.results[0]).toMatchObject({ status: 'rejected', reason: 'task_not_found' });
    expect((await sync(customer, device2, [pickOp(t.taskId, t.lines[0]!, 1)])).status).toBe(403);
    expect((await sync(picker1, device1, [{ ...pickOp(t.taskId, t.lines[0]!, 1), extra: 'x' }])).status).toBe(
      400,
    );
  });

  it('load-sheds bursts of sync requests with 429 + Retry-After', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 45; i++) codes.push((await sync(picker2, device2, [completeOp(newId())])).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    const limited = await sync(picker2, device2, [completeOp(newId())]);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('invariants I1–I4, I6, I7 hold (I5 needs a running publisher; none runs in the db project)', async () => {
    const rows = await checkInvariants(databaseUrl());
    evidence.invariants = rows.map((r) => `${r.invariant}:${r.status}`);
    for (const r of rows.filter((x) => x.invariant !== 'I5'))
      expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
  });
});
