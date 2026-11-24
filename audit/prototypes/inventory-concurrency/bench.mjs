// RetailFlow audit prototype: inventory reservation concurrency on real PostgreSQL.
// Runs an embedded PostgreSQL (no Docker). Every number printed is measured, not assumed.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Pool, Client } = pg;
const PORT = +(process.env.PGPORT_AUDIT || 54329);
const DATA = path.resolve(process.env.PGDATA_DIR || './pgdata');
const results = { env: {}, tests: {} };
const log = (...a) => console.log(...a);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};
const errCode = (e) => e?.code || e?.message?.slice(0, 40);

fs.rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: DATA, user: 'postgres', password: 'audit', port: PORT, persistent: false,
  postgresFlags: ['-c', 'max_connections=100', '-c', 'deadlock_timeout=1s'],
  onLog: (m) => fs.appendFileSync('pg-server.log', String(m) + '\n'),
  onError: (m) => fs.appendFileSync('pg-server.log', String(m) + '\n'),
});
fs.rmSync('pg-server.log', { force: true });
const ONLY = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const run = (t) => !ONLY || ONLY.has(t);
const save = () => fs.writeFileSync(process.env.OUT || 'results.json', JSON.stringify(results, null, 2));
await server.initialise();
await server.start();
await server.createDatabase('retailflow');
const conn = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'audit', database: 'retailflow' };
const admin = new Client(conn); await admin.connect();
const ver = (await admin.query('select version()')).rows[0].version;
results.env = { postgres: ver, node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0].model,
  ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), platform: `${os.platform()} ${os.release()}`,
  note: 'Single laptop; client and DB on same host; fsync on (default durability).' };
log('ENV', results.env);

await admin.query(`
  CREATE TABLE inv_naive (store_id int, sku text, on_hand int NOT NULL, reserved int NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, sku));
  CREATE TABLE inventory (store_id int, sku text, on_hand int NOT NULL, reserved int NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, sku), CONSTRAINT reserved_bounds CHECK (reserved >= 0 AND reserved <= on_hand));
  CREATE TABLE reservations (id bigserial PRIMARY KEY, order_id text NOT NULL, store_id int NOT NULL,
    sku text NOT NULL, qty int NOT NULL CHECK (qty > 0), status text NOT NULL DEFAULT 'active',
    idempotency_key text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX reservations_idem ON reservations (idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE TABLE outbox (id bigserial PRIMARY KEY, aggregate_id text NOT NULL, event_type text NOT NULL,
    payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
`);

async function reset(rows, table = 'inventory') {
  await admin.query(`TRUNCATE ${table}; TRUNCATE reservations RESTART IDENTITY; TRUNCATE outbox RESTART IDENTITY;`);
  // rows: array of [store, sku, on_hand]
  const chunk = 5000;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await admin.query(
      `INSERT INTO ${table}(store_id, sku, on_hand) SELECT * FROM unnest($1::int[], $2::text[], $3::int[])`,
      [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])]);
  }
}

// ---------- reservation strategies ----------
async function reserveNaive(pool, store, sku, qty, orderId) {
  // Read-then-write in application code: the common bug.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT on_hand, reserved FROM inv_naive WHERE store_id=$1 AND sku=$2', [store, sku]);
    if (!rows.length || rows[0].on_hand - rows[0].reserved < qty) { await c.query('ROLLBACK'); return 'insufficient'; }
    await c.query('UPDATE inv_naive SET reserved=$3 WHERE store_id=$1 AND sku=$2', [store, sku, rows[0].reserved + qty]);
    await c.query('INSERT INTO reservations(order_id, store_id, sku, qty) VALUES ($1,$2,$3,$4)', [orderId, store, sku, qty]);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return errCode(e); } finally { c.release(); }
}

async function reserveSerializable(pool, store, sku, qty, orderId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const { rows } = await c.query('SELECT on_hand, reserved FROM inventory WHERE store_id=$1 AND sku=$2', [store, sku]);
    if (!rows.length || rows[0].on_hand - rows[0].reserved < qty) { await c.query('ROLLBACK'); return 'insufficient'; }
    await c.query('UPDATE inventory SET reserved=$3 WHERE store_id=$1 AND sku=$2', [store, sku, rows[0].reserved + qty]);
    await c.query('INSERT INTO reservations(order_id, store_id, sku, qty) VALUES ($1,$2,$3,$4)', [orderId, store, sku, qty]);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return errCode(e); } finally { c.release(); }
}

// Recommended: idempotent insert + guarded atomic decrement + outbox, one transaction.
async function reserveAtomic(pool, store, sku, qty, orderId, idemKey = null, timings = null) {
  const t0 = performance.now();
  const c = await pool.connect();
  const t1 = performance.now();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      `INSERT INTO reservations(order_id, store_id, sku, qty, idempotency_key) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [orderId, store, sku, qty, idemKey]);
    if (!ins.rowCount) { await c.query('ROLLBACK'); return 'duplicate'; }
    const upd = await c.query(
      `UPDATE inventory SET reserved = reserved + $3
       WHERE store_id=$1 AND sku=$2 AND on_hand - reserved >= $3`, [store, sku, qty]);
    if (!upd.rowCount) { await c.query('ROLLBACK'); return 'insufficient'; }
    await c.query(`INSERT INTO outbox(aggregate_id, event_type, payload) VALUES ($1,'InventoryReserved',$2)`,
      [`${store}:${sku}`, JSON.stringify({ orderId, store, sku, qty, reservationId: ins.rows[0].id })]);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return errCode(e); }
  finally { c.release(); if (timings) { timings.wait.push(t1 - t0); timings.total.push(performance.now() - t0); } }
}

// Multi-line order: all lines in one transaction.
async function reserveOrder(pool, store, lines, orderId, sorted) {
  const ls = sorted ? [...lines].sort((a, b) => a.sku.localeCompare(b.sku)) : lines;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const l of ls) {
      const upd = await c.query(`UPDATE inventory SET reserved = reserved + $3
        WHERE store_id=$1 AND sku=$2 AND on_hand - reserved >= $3`, [store, l.sku, l.qty]);
      if (!upd.rowCount) { await c.query('ROLLBACK'); return 'insufficient'; }
    }
    await c.query('COMMIT');
    return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return errCode(e); } finally { c.release(); }
}

const tally = (arr) => arr.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});

// ---------- T1: last-unit race ----------
log('\nT1 last-unit / small-stock race');
results.tests.T1_oversell = [];
let serRetries = 0;
const reserveSerializableRetry = async (pool, s, k, q, o) => {
  for (let i = 0; i < 20; i++) {
    const r = await reserveSerializable(pool, s, k, q, o);
    if (r !== '40001') { serRetries += i; return r; }
    await new Promise((res) => setTimeout(res, Math.random() * 5 * (i + 1)));
  }
  return 'gave_up_after_20';
};
for (const [stock, attempts] of (run('T1') ? [[1, 200], [10, 200], [10, 500]] : [])) {
  const pool = new Pool({ ...conn, max: 50 });
  for (const strat of ['naive_read_then_write', 'serializable_read_then_write', 'serializable_with_retry', 'atomic_conditional_update']) {
    const table = strat === 'naive_read_then_write' ? 'inv_naive' : 'inventory';
    await reset([[1, 'SKU-LAST', stock]], table);
    const fn = { naive_read_then_write: reserveNaive, serializable_read_then_write: reserveSerializable,
      serializable_with_retry: reserveSerializableRetry, atomic_conditional_update: reserveAtomic }[strat];
    // Warm the pool so all 50 connections exist before the race (cold Windows backends stagger requests).
    await Promise.all(Array.from({ length: 50 }, () => pool.query('SELECT pg_sleep(0.05)')));
    const t = performance.now();
    const out = await Promise.all(Array.from({ length: attempts }, (_, i) => fn(pool, 1, 'SKU-LAST', 1, `o${i}`)));
    const ms = performance.now() - t;
    const resCount = +(await admin.query('SELECT count(*) FROM reservations')).rows[0].count;
    const inv = (await admin.query(`SELECT on_hand, reserved FROM ${table}`)).rows[0];
    const row = { strategy: strat, stock, attempts, poolMax: 50, outcomes: tally(out), reservationsCreated: resCount,
      finalReservedCounter: inv.reserved, oversold: Math.max(0, resCount - stock),
      counterMismatch: resCount !== inv.reserved, elapsedMs: +ms.toFixed(1),
      ...(strat === 'serializable_with_retry' ? { totalSerializationRetries: serRetries } : {}) };
    serRetries = 0;
    results.tests.T1_oversell.push(row); log(row); save();
  }
  await pool.end();
}

// ---------- T2: idempotency under concurrent duplicate submits ----------
if (run('T2')) {
log('\nT2 idempotency: 100 concurrent retries of the same request');
{
  const pool = new Pool({ ...conn, max: 50 });
  await reset([[1, 'SKU-A', 100]]);
  const out = await Promise.all(Array.from({ length: 100 }, () => reserveAtomic(pool, 1, 'SKU-A', 2, 'order-1', 'idem-order-1-SKU-A')));
  const inv = (await admin.query('SELECT reserved FROM inventory')).rows[0];
  const r = { outcomes: tally(out), reservations: +(await admin.query('SELECT count(*) FROM reservations')).rows[0].count,
    reservedCounter: inv.reserved, outboxRows: +(await admin.query('SELECT count(*) FROM outbox')).rows[0].count };
  results.tests.T2_idempotency = r; log(r); save();
  await pool.end();
}

} // end T2
// ---------- T3: throughput / latency vs concurrency, hot SKU vs spread ----------
if (run('T3')) {
log('\nT3 throughput vs concurrency (pool max=20 per process, 1 process)');
results.tests.T3_throughput = [];
const scen = [
  { name: 'A', vus: 10, products: 500, ops: 2000 },
  { name: 'B', vus: 50, products: 5000, ops: 4000 },
  { name: 'C', vus: 200, products: 20000, ops: 6000 },
  { name: 'D', vus: 500, products: 50000, ops: 8000 },
];
for (const s of scen) {
  for (const dist of ['uniform', 'hot_1pct_gets_80pct', 'single_hot_sku']) {
    await reset(Array.from({ length: s.products }, (_, i) => [1, `SKU-${i}`, 1_000_000]));
    const pool = new Pool({ ...conn, max: 20 });
    const timings = { wait: [], total: [] };
    const pick = () => {
      if (dist === 'single_hot_sku') return 'SKU-0';
      if (dist === 'hot_1pct_gets_80pct') {
        const hot = Math.max(1, Math.floor(s.products / 100));
        return Math.random() < 0.8 ? `SKU-${Math.floor(Math.random() * hot)}` : `SKU-${Math.floor(Math.random() * s.products)}`;
      }
      return `SKU-${Math.floor(Math.random() * s.products)}`;
    };
    let issued = 0; const outs = [];
    const worker = async (w) => { while (issued < s.ops) { const i = issued++; outs.push(await reserveAtomic(pool, 1, pick(), 1, `o${w}-${i}`, null, timings)); } };
    const t = performance.now();
    await Promise.all(Array.from({ length: s.vus }, (_, w) => worker(w)));
    const sec = (performance.now() - t) / 1000;
    const sumRes = +(await admin.query('SELECT coalesce(sum(reserved),0) s FROM inventory')).rows[0].s;
    const row = { scenario: s.name, concurrentClients: s.vus, products: s.products, distribution: dist, ops: s.ops,
      throughputTxPerSec: +(s.ops / sec).toFixed(0), p50ms: pct(timings.total, 50), p95ms: pct(timings.total, 95),
      p99ms: pct(timings.total, 99), poolWaitP50ms: pct(timings.wait, 50), poolWaitP95ms: pct(timings.wait, 95),
      errors: outs.filter((o) => o !== 'ok').length, invariantHolds: sumRes === outs.filter((o) => o === 'ok').length };
    results.tests.T3_throughput.push(row); log(row); save();
    await pool.end();
  }
}

} // end T3
// ---------- T4: deadlocks in multi-line orders ----------
log('\nT4 multi-line orders (5 lines from 20 hot SKUs), 100 concurrent, up to 1000 orders or 60 s');
results.tests.T4_deadlocks = [];
for (const sorted of (run('T4') ? [false, true] : [])) {
  await reset(Array.from({ length: 20 }, (_, i) => [1, `SKU-${String(i).padStart(2, '0')}`, 1_000_000]));
  const before = +(await admin.query(`SELECT deadlocks FROM pg_stat_database WHERE datname='retailflow'`)).rows[0].deadlocks;
  const pool = new Pool({ ...conn, max: 80 });
  const lat = [];
  const orders = Array.from({ length: 1000 }, () => {
    const set = new Set(); while (set.size < 5) set.add(`SKU-${String(Math.floor(Math.random() * 20)).padStart(2, '0')}`);
    return [...set].map((sku) => ({ sku, qty: 1 }));
  });
  let idx = 0; const outs = [];
  const t = performance.now(); const deadline = t + 60_000;
  await Promise.all(Array.from({ length: 100 }, async () => {
    while (idx < orders.length && performance.now() < deadline) { const o = orders[idx++]; const s0 = performance.now(); outs.push(await reserveOrder(pool, 1, o, 'x', sorted)); lat.push(performance.now() - s0); }
  }));
  const sec = (performance.now() - t) / 1000;
  const after = +(await admin.query(`SELECT deadlocks FROM pg_stat_database WHERE datname='retailflow'`)).rows[0].deadlocks;
  const okCount = outs.filter((o) => o === 'ok').length;
  const row = { lockOrder: sorted ? 'sorted_by_sku' : 'arbitrary', ordersAttempted: outs.length, elapsedSec: +sec.toFixed(1),
    outcomes: tally(outs), deadlocksDetected: after - before,
    committedOrdersPerSec: +(okCount / sec).toFixed(1), p50ms: pct(lat, 50), p99ms: pct(lat, 99), maxMs: pct(lat, 100) };
  results.tests.T4_deadlocks.push(row); log(row); save();
  await pool.end();
}

// ---------- T5: connection exhaustion (replicas x pool > max_connections) ----------
if (run('T5')) {
log('\nT5 connection exhaustion: 6 simulated replicas x pool 20 = 120 vs max_connections=100');
{
  const pools = Array.from({ length: 6 }, () => new Pool({ ...conn, max: 20, connectionTimeoutMillis: 30000 }));
  await reset([[1, 'SKU-0', 1_000_000]]);
  const outs = await Promise.all(pools.flatMap((p) => Array.from({ length: 20 }, async () => {
    try { const c = await p.connect(); await c.query('SELECT pg_sleep(0.5)'); c.release(); return 'ok'; }
    catch (e) { return errCode(e); }
  })));
  const r = { attemptedConnections: 120, outcomes: tally(outs) };
  results.tests.T5_conn_exhaustion = r; log(r); save();
  await Promise.all(pools.map((p) => p.end()));
}

} // end T5
// ---------- T6: outbox high-watermark polling skips late-committing rows ----------
if (run('T6')) {
log('\nT6 outbox publisher using "WHERE id > last_published_id" polling');
{
  await admin.query('TRUNCATE outbox RESTART IDENTITY');
  const a = new Client(conn), b = new Client(conn); await a.connect(); await b.connect();
  await a.query('BEGIN');
  await a.query(`INSERT INTO outbox(aggregate_id,event_type,payload) VALUES ('X','A_slow_tx','{}')`); // gets id 1, not committed
  await b.query(`INSERT INTO outbox(aggregate_id,event_type,payload) VALUES ('Y','B_fast_tx','{}')`); // id 2, autocommit
  let watermark = 0; const published = [];
  const poll = async () => { const { rows } = await admin.query('SELECT id, event_type FROM outbox WHERE id > $1 ORDER BY id', [watermark]);
    for (const r of rows) { published.push(r.event_type); watermark = Math.max(watermark, +r.id); } };
  await poll();                 // sees id 2 only; watermark -> 2
  await a.query('COMMIT');      // id 1 now visible, but below watermark
  await poll();
  const r = { published, watermark, everCommitted: (await admin.query('SELECT id, event_type FROM outbox ORDER BY id')).rows,
    lostEvents: (await admin.query('SELECT event_type FROM outbox WHERE id <= $1', [watermark])).rows.map((x) => x.event_type).filter((e) => !published.includes(e)) };
  results.tests.T6_outbox_watermark = r; log(r); save();
  await a.end(); await b.end();
}

} // end T6
// ---------- T7: reservation release vs pick-confirm race ----------
if (run('T7')) {
log('\nT7 expiry-release job racing with pick confirmation (500 trials each)');
results.tests.T7_release_race = [];
for (const guarded of [false, true]) {
  const pool = new Pool({ ...conn, max: 20 });
  let doubleApplied = 0, constraintErrors = 0;
  for (let i = 0; i < 500; i++) {
    await reset([[1, 'SKU-R', 10]]);
    await admin.query(`UPDATE inventory SET reserved=1; INSERT INTO reservations(order_id,store_id,sku,qty) VALUES ('o',1,'SKU-R',1)`);
    const release = async () => { const c = await pool.connect(); try {
      await c.query('BEGIN');
      if (!guarded) {
        const r = await c.query(`SELECT status FROM reservations WHERE id=1`);
        if (r.rows[0].status !== 'active') { await c.query('ROLLBACK'); return; }
        await c.query(`UPDATE reservations SET status='released' WHERE id=1`);
      } else {
        const r = await c.query(`UPDATE reservations SET status='released' WHERE id=1 AND status='active'`);
        if (!r.rowCount) { await c.query('ROLLBACK'); return; }
      }
      await c.query(`UPDATE inventory SET reserved = reserved - 1 WHERE sku='SKU-R'`);
      await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); if (e.code === '23514') constraintErrors++; } finally { c.release(); } };
    const confirm = async () => { const c = await pool.connect(); try {
      await c.query('BEGIN');
      if (!guarded) {
        const r = await c.query(`SELECT status FROM reservations WHERE id=1`);
        if (r.rows[0].status !== 'active') { await c.query('ROLLBACK'); return; }
        await c.query(`UPDATE reservations SET status='picked' WHERE id=1`);
      } else {
        const r = await c.query(`UPDATE reservations SET status='picked' WHERE id=1 AND status='active'`);
        if (!r.rowCount) { await c.query('ROLLBACK'); return; }
      }
      await c.query(`UPDATE inventory SET reserved = reserved - 1, on_hand = on_hand - 1 WHERE sku='SKU-R'`);
      await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); if (e.code === '23514') constraintErrors++; } finally { c.release(); } };
    await Promise.all([release(), confirm()]);
    const inv = (await admin.query(`SELECT on_hand, reserved FROM inventory`)).rows[0];
    // Correct end states: (10,0) if release won, (9,0) if confirm won.
    if (!((inv.on_hand === 10 || inv.on_hand === 9) && inv.reserved === 0)) doubleApplied++;
  }
  const row = { stateTransition: guarded ? 'guarded_compare_and_set' : 'read_then_update', trials: 500,
    corruptedFinalStates: doubleApplied, checkConstraintRejections: constraintErrors };
  results.tests.T7_release_race.push(row); log(row); save();
  await pool.end();
}

} // end T7
await admin.end();
await server.stop();
fs.writeFileSync(process.env.OUT || 'results.json', JSON.stringify(results, null, 2));
log('\nwrote results.json');
