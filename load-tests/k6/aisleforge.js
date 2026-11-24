// AisleForge k6 workload — the corrected successor of audit/load-tests/k6/retailflow-load.js (kept unmodified as
// audit evidence). Fixes, per docs/architecture/PHASE0_AUDIT_REVIEW.md §k6:
//   1. 409 (insufficient stock) and 422 are expected business outcomes, not failures (responseCallback).
//   2. Orders come from many customer principals (seeded load-customer-N accounts), not one.
//   3. Reconnect-storm ops target REAL tasks the simulated picker claimed (no fabricated task ids).
//   4./5. Op ids from the built-in crypto.randomUUID(); no remote jslib import (runs offline).
//   6. One write path: picks are sent through POST /api/v1/sync, as the PWA does.
//   7. Summary written to /results (a mounted directory) under a unique name.
//
// Run (inside the compose network, see tools/load/run-profile.ps1):
//   k6 run -e PROFILE=A -e WINDOW_MIN=3 -e LABEL=pre-redis -e PASSWORD=... /scripts/aisleforge.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
// crypto is not a global in k6 0.55: without this import every iteration threw ReferenceError (first baseline attempt).
import { crypto } from 'k6/experimental/webcrypto';
import { Counter, Rate, Trend } from 'k6/metrics';

const PROFILES = {
  //        employees, orders per window, products, window (min), stores, customers
  A: { employees: 10, orders: 100, products: 500, windowMin: 10, stores: 1, customers: 50 },
  B: { employees: 50, orders: 1000, products: 5000, windowMin: 15, stores: 2, customers: 200 },
  C: { employees: 200, orders: 5000, products: 20000, windowMin: 20, stores: 5, customers: 500 },
  D: { employees: 500, orders: 10000, products: 50000, windowMin: 20, stores: 10, customers: 1000 },
};
const NAME = __ENV.PROFILE || 'A';
const SHAPE = __ENV.SHAPE || 'steady'; // steady | burst
const P = PROFILES[NAME];
// The ARRIVAL RATE of the profile is preserved; WINDOW_MIN only shortens how long it is sustained.
// Expressed per MINUTE: k6 arrival-rate targets must be integers (A's 0.167/s is 10/min).
const ordersPerMin = Math.max(1, Math.round(P.orders / P.windowMin));
const WINDOW = Number(__ENV.WINDOW_MIN || P.windowMin);
const BASE = __ENV.BASE_URL || 'http://web:8080';
const PASSWORD = __ENV.PASSWORD;
const HOT_SHARE = Number(__ENV.HOT_SHARE || 0.3);
const DUP_SHARE = Number(__ENV.DUP_SHARE || 0.02);
const THINK = Number(__ENV.THINK_SECONDS || 4);
const HOT = Math.max(1, Math.floor(P.products / 100));

const ordersCreated = new Counter('orders_created');
const reserveConflicts = new Counter('reserve_conflicts');
const duplicateReplays = new Counter('duplicate_replays');
const orderErrors = new Rate('order_errors');
const syncLatency = new Trend('sync_batch_latency', true);
const stormLatency = new Trend('storm_sync_latency', true);
const syncRejected = new Counter('sync_ops_rejected');
const syncApplied = new Counter('sync_ops_applied');
const syncShed = new Counter('sync_load_shed_429');
const tasksCompleted = new Counter('tasks_completed');
const catalogLatency = new Trend('catalog_latency', true);
const catalogCacheHits = new Counter('catalog_cache_hits');
const catalogCacheMisses = new Counter('catalog_cache_misses');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 422));

const orderStages =
  SHAPE === 'burst'
    ? [
        { target: ordersPerMin * 10, duration: '20s' }, // flash sale: 10× the profile rate
        { target: ordersPerMin * 10, duration: `${Math.max(1, WINDOW * 60 - 40)}s` },
        { target: 0, duration: '20s' },
      ]
    : [
        { target: ordersPerMin, duration: '30s' },
        { target: ordersPerMin, duration: `${Math.max(1, Math.round(WINDOW * 60 * 0.6))}s` },
        { target: ordersPerMin * 2, duration: `${Math.max(1, Math.round(WINDOW * 60 * 0.2))}s` }, // traffic doubles
        { target: ordersPerMin, duration: `${Math.max(1, Math.round(WINDOW * 60 * 0.2))}s` }, // and returns
      ];

export const options = {
  setupTimeout: '10m',
  scenarios: {
    customers: {
      executor: 'ramping-arrival-rate',
      exec: 'placeOrder',
      timeUnit: '1m',
      startRate: 0,
      preAllocatedVUs: 20,
      maxVUs: 400,
      stages: orderStages,
    },
    pickers: {
      executor: 'constant-vus',
      exec: 'pickerShift',
      vus: P.employees,
      duration: `${WINDOW * 60 + 30}s`,
    },
    reconnect_storm: {
      // Every device reconnects at once after an outage: each VU claims a real task, records its picks
      // "offline", then all upload at the same moment.
      executor: 'per-vu-iterations',
      exec: 'offlineReconnect',
      vus: P.employees,
      iterations: 1,
      startTime: `${Math.floor((WINDOW * 60) / 2)}s`,
      maxDuration: `${WINDOW * 60}s`,
    },
  },
  thresholds: {
    order_errors: ['rate<0.01'],
    'http_req_duration{scenario:customers}': ['p(95)<2000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function login(email) {
  const r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login' },
  });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${r.body}`);
  return r.json('accessToken');
}

export function setup() {
  if (!PASSWORD) throw new Error('PASSWORD is required');
  const customers = [];
  for (let i = 1; i <= P.customers; i++) customers.push(login(`load-customer-${i}@load.aisleforge.test`));
  const pickers = [];
  for (let i = 1; i <= P.employees; i++) pickers.push(login(`load-picker-${i}@load.aisleforge.test`));
  return { customers, pickers };
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const sku = (i) => `LOAD-${String(i).padStart(6, '0')}`;
const randomSku = () =>
  Math.random() < HOT_SHARE
    ? sku(1 + Math.floor(Math.random() * HOT))
    : sku(HOT + 1 + Math.floor(Math.random() * (P.products - HOT)));

export function placeOrder(data) {
  const token = data.customers[exec.scenario.iterationInTest % data.customers.length];
  // Browse a catalog page first (display-only availability; Phase 7 compares this with Redis off/on).
  const browseStore = 1 + Math.floor(Math.random() * P.stores);
  const page = Math.floor(Math.random() * 5) * 50;
  const cat = http.get(`${BASE}/api/v1/stores/${browseStore}/catalog?limit=50&offset=${page}`, {
    headers: auth(token),
    tags: { name: 'browse_catalog' },
  });
  catalogLatency.add(cat.timings.duration);
  if (cat.headers['X-Cache'] === 'HIT') catalogCacheHits.add(1);
  else if (cat.headers['X-Cache'] === 'MISS') catalogCacheMisses.add(1);
  const lines = {};
  const n = 1 + Math.floor(Math.random() * 4);
  for (let k = 0; k < n; k++) lines[randomSku()] = 1 + Math.floor(Math.random() * 2);
  const body = JSON.stringify({
    storeId: 1 + Math.floor(Math.random() * P.stores),
    lines: Object.entries(lines).map(([s, q]) => ({ sku: s, qty: q })),
  });
  const key = `k6-${crypto.randomUUID()}`;
  const params = { headers: { ...auth(token), 'Idempotency-Key': key }, tags: { name: 'place_order' } };
  const r = http.post(`${BASE}/api/v1/orders`, body, params);
  const ok = r.status === 201 || r.status === 409 || r.status === 422;
  orderErrors.add(!ok);
  if (r.status === 201) ordersCreated.add(1);
  if (r.status === 409) reserveConflicts.add(1);
  check(r, { 'order accepted or business-rejected': () => ok });
  if (ok && Math.random() < DUP_SHARE) {
    // A client retry with the SAME key must replay the original outcome, never create a second order.
    const again = http.post(`${BASE}/api/v1/orders`, body, {
      ...params,
      tags: { name: 'place_order_retry' },
    });
    if (again.headers['Idempotent-Replayed'] === 'true') duplicateReplays.add(1);
    check(again, { 'retry replays the original status': (x) => x.status === r.status });
  }
}

function claimOne(token) {
  const list = http.get(`${BASE}/api/v1/pick-tasks?scope=available&limit=20`, {
    headers: auth(token),
    tags: { name: 'list_tasks' },
  });
  if (list.status !== 200) return null;
  const tasks = list.json('tasks') || [];
  for (const t of tasks) {
    const c = http.post(`${BASE}/api/v1/pick-tasks/${t.id}/claim`, null, {
      headers: auth(token),
      tags: { name: 'claim' },
    });
    if (c.status === 200) return c.json('task');
  }
  return null;
}

let seq = 0;
const deviceFor = {};
function device() {
  const vu = exec.vu.idInTest;
  if (!deviceFor[vu]) deviceFor[vu] = crypto.randomUUID();
  return deviceFor[vu];
}

function sendOps(token, ops, trend) {
  const t0 = Date.now();
  const r = http.post(`${BASE}/api/v1/sync`, JSON.stringify({ deviceId: device(), ops }), {
    headers: auth(token),
    tags: { name: 'sync' },
  });
  trend.add(Date.now() - t0);
  if (r.status === 429) {
    syncShed.add(1);
    return 'shed';
  }
  if (r.status !== 200) return 'error';
  for (const res of r.json('results')) {
    if (res.status === 'applied' || (res.status === 'duplicate' && res.original === 'applied'))
      syncApplied.add(1);
    if (res.status === 'rejected') syncRejected.add(1);
  }
  return 'ok';
}

const pickOps = (task) =>
  (task.lines || [])
    .filter((l) => l.reservationStatus === 'active')
    .map((l) => ({
      opId: crypto.randomUUID(),
      seq: ++seq,
      type: 'pick.confirm',
      taskId: task.id,
      payload: {
        orderLineId: l.orderLineId,
        scannedSku: l.sku,
        pickedQty: Math.random() < 0.05 ? Math.max(0, l.qty - 1) : l.qty,
      },
    }));

export function pickerShift(data) {
  const token = data.pickers[(exec.vu.idInTest - 1) % data.pickers.length];
  const task = claimOne(token);
  if (!task) {
    sleep(THINK);
    return;
  }
  for (const op of pickOps(task)) {
    sleep(THINK * (0.5 + Math.random())); // a human walks to the bin and scans
    if (sendOps(token, [op], syncLatency) === 'shed') sleep(5);
  }
  const done = sendOps(
    token,
    [{ opId: crypto.randomUUID(), seq: ++seq, type: 'task.complete', taskId: task.id, payload: {} }],
    syncLatency,
  );
  if (done === 'ok') tasksCompleted.add(1);
}

export function offlineReconnect(data) {
  const token = data.pickers[(exec.vu.idInTest - 1) % data.pickers.length];
  const task = claimOne(token);
  if (!task) return;
  const ops = pickOps(task);
  if (ops.length === 0) return;
  sleep(10 - ((Date.now() / 1000) % 10)); // align every device on the same 10 s boundary: the "Wi-Fi comes back" moment
  sendOps(token, ops, stormLatency);
}

export function handleSummary(d) {
  const label = __ENV.LABEL || 'run';
  const out = `/results/k6-summary-${NAME}-${SHAPE}-${label}.json`;
  return { [out]: JSON.stringify(d, null, 2), stdout: `summary written to ${out}\n` };
}
