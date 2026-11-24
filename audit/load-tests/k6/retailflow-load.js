// RetailFlow k6 load profile — TEMPLATE. NOT YET EXECUTED: no API exists in this repo yet.
// It targets the API contract proposed in audit/RETAILFLOW_AUDIT.md §13.
//
// Run:  k6 run -e PROFILE=B -e BASE_URL=http://localhost:8080 audit/load-tests/k6/retailflow-load.js
//
// Workload model (deliberately separates the three things people conflate):
//   * "employees"  = simulated pickers. Each is ONE closed-model VU with think time
//                    (a human scans roughly every 15-30 s, not as fast as possible).
//   * "orders"     = open-model arrivals (ramping-arrival-rate). Customers do not wait for
//                    each other, so order load must not be modelled as closed-loop VUs.
//   * "requests/s" = an OUTPUT you measure, not an input you configure.
//
// Distributions matter more than counts. HOT_SHARE of order lines hit the hottest 1% of SKUs,
// because hot-row contention is the measured first breaking point (audit §9).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const PROFILES = {
  //       employees, orders over the window, products, window,  stores
  A: { employees: 10,  orders: 100,    products: 500,    windowMin: 10, stores: 1 },
  B: { employees: 50,  orders: 1000,   products: 5000,   windowMin: 15, stores: 2 },
  C: { employees: 200, orders: 5000,   products: 20000,  windowMin: 20, stores: 5 },
  D: { employees: 500, orders: 10000,  products: 50000,  windowMin: 20, stores: 10 },
  // Burst: same orders as D, delivered in 2 minutes (flash-sale shape).
  BURST: { employees: 500, orders: 10000, products: 50000, windowMin: 2, stores: 10 },
};
const P = PROFILES[__ENV.PROFILE || 'A'];
const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const HOT_SHARE = Number(__ENV.HOT_SHARE || 0.3);
const ordersPerSec = P.orders / (P.windowMin * 60);

const reserveConflicts = new Counter('reserve_conflicts');      // 409 insufficient stock: expected, not an error
const duplicateReplays = new Counter('duplicate_replays');      // idempotent replays
const syncRejected = new Counter('sync_ops_rejected');
const syncLatency = new Trend('sync_batch_latency', true);

export const options = {
  scenarios: {
    customers: {
      executor: 'ramping-arrival-rate', exec: 'placeOrder', timeUnit: '1s',
      startRate: 0, preAllocatedVUs: 50, maxVUs: 1000,
      stages: [
        { target: ordersPerSec, duration: '1m' },
        { target: ordersPerSec, duration: `${Math.max(1, P.windowMin - 2)}m` },
        { target: ordersPerSec * 2, duration: '1m' },   // "what happens when traffic doubles"
        { target: ordersPerSec, duration: '2m' },       // "does it recover when traffic returns"
      ],
    },
    pickers: {
      executor: 'constant-vus', exec: 'pickerShift', vus: P.employees, duration: `${P.windowMin + 2}m`,
    },
    reconnect_storm: {  // every device reconnects at once after a simulated Wi-Fi outage
      executor: 'per-vu-iterations', exec: 'offlineReconnect', vus: P.employees, iterations: 1,
      startTime: `${Math.floor(P.windowMin / 2)}m`,
    },
  },
  thresholds: {
    'http_req_failed{scenario:customers}': ['rate<0.01'],
    'http_req_duration{scenario:customers}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{scenario:pickers}': ['p(95)<200'],
    sync_batch_latency: ['p(95)<2000'],
  },
};

const sku = () => {
  const hot = Math.max(1, Math.floor(P.products / 100));
  const i = Math.random() < HOT_SHARE ? Math.floor(Math.random() * hot) : Math.floor(Math.random() * P.products);
  return `SKU-${i}`;
};
const store = () => 1 + Math.floor(Math.random() * P.stores);

export function setup() {
  // Tokens for a pool of seeded test employees (seed script must create emp-1..emp-N with password 'loadtest').
  const tokens = [];
  for (let i = 1; i <= P.employees; i++) {
    const r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ username: `emp-${i}`, password: 'loadtest' }),
      { headers: { 'Content-Type': 'application/json' } });
    tokens.push(r.json('accessToken'));
  }
  const svc = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ username: 'loadtest-customer', password: 'loadtest' }),
    { headers: { 'Content-Type': 'application/json' } }).json('accessToken');
  return { tokens, svc };
}

export function placeOrder(data) {
  const lines = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => ({ sku: sku(), qty: 1 }));
  const key = uuidv4();
  const body = JSON.stringify({ storeId: store(), lines });
  const params = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.svc}`, 'Idempotency-Key': key } };
  const r = http.post(`${BASE}/api/v1/orders`, body, params);
  if (r.status === 409) reserveConflicts.add(1);
  check(r, { 'order accepted or out-of-stock': (x) => x.status === 201 || x.status === 409 });
  // 5% of clients retry the identical request (lost response). Must return the original result, never a 2nd order.
  if (Math.random() < 0.05) {
    const again = http.post(`${BASE}/api/v1/orders`, body, params);
    if (again.status === r.status) duplicateReplays.add(1);
    check(again, { 'idempotent replay returns same status': (x) => x.status === r.status });
  }
}

export function pickerShift(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const h = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  const task = http.post(`${BASE}/api/v1/pick-tasks/claim`, null, h);
  if (task.status !== 200) { sleep(5); return; }
  const t = task.json();
  for (const item of t.items || []) {
    sleep(15 + Math.random() * 15); // walk + scan think time
    const r = http.post(`${BASE}/api/v1/pick-tasks/${t.id}/scans`,
      JSON.stringify({ opId: uuidv4(), sku: item.sku, qty: item.qty }), h);
    check(r, { 'scan ok': (x) => x.status === 200 || x.status === 409 });
  }
  http.post(`${BASE}/api/v1/pick-tasks/${t.id}/complete`, null, h);
}

export function offlineReconnect(data) {
  // Each device uploads a backlog equivalent to ~30 offline minutes (60-120 queued ops).
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const n = 60 + Math.floor(Math.random() * 60);
  const ops = Array.from({ length: n }, (_, i) => ({
    opId: uuidv4(), seq: i + 1, type: 'PICK_SCAN', taskId: `seeded-task-${__VU}`, sku: sku(), qty: 1,
    baseVersion: 1, clientTime: new Date().toISOString(),
  }));
  const t0 = Date.now();
  const r = http.post(`${BASE}/api/v1/sync`, JSON.stringify({ deviceId: `device-${__VU}`, ops }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: '60s' });
  syncLatency.add(Date.now() - t0);
  if (r.status === 200) syncRejected.add((r.json('results') || []).filter((x) => x.status === 'rejected').length);
  check(r, { 'sync answered per-op': (x) => x.status === 200 && Array.isArray(x.json('results')) });
}

export function handleSummary(d) {
  return { [`audit/load-tests/results/summary-${__ENV.PROFILE || 'A'}.json`]: JSON.stringify(d, null, 2) };
}
