import type { PgClient, PgPool } from '@aisleforge/database';
import {
  planRoute,
  WarehouseGraph,
  type ExposureLimit,
  type PickRequest,
  type RoutePlan,
  type TemperatureZone,
  type WarehouseLayout,
} from '@aisleforge/routing';
import { newId } from '@aisleforge/shared';

export type RouteStatus = 'feasible' | 'fallback' | 'infeasible' | 'unplanned';

export interface TaskStop {
  sequence: number;
  orderLineId: string;
  sku: string;
  aisle: number;
  pos: number;
  zone: TemperatureZone;
  arrivalDistanceMeters: number;
  arrivalSeconds: number;
}

/** Stored in pick_tasks.route. `unrouted` lines are still picked; they are listed after the routed stops. */
export interface TaskRoute {
  algorithm: string | null;
  distanceMeters: number | null;
  estimatedSeconds: number | null;
  solveMs: number | null;
  fallbackUsed: boolean;
  layout: { id: string; version: number } | null;
  stops: TaskStop[];
  unrouted: { orderLineId: string; sku: string; reason: string }[];
  /** For infeasible/unplanned routes: why (shown to supervisors). */
  reason: string | null;
}

export interface PlannedTask {
  routeStatus: RouteStatus;
  route: TaskRoute;
}

interface LineRow {
  id: string;
  sku: string;
  zone: TemperatureZone;
  aisle: number | null;
  pos: number | null;
}

interface StoredLayout extends WarehouseLayout {
  exposureLimits?: ExposureLimit[];
}

const graphCache = new Map<string, WarehouseGraph>();
function graphFor(layout: WarehouseLayout): WarehouseGraph {
  const key = `${layout.id}@${layout.version}`;
  let g = graphCache.get(key);
  if (!g) {
    g = new WarehouseGraph(layout);
    if (graphCache.size > 50) graphCache.clear();
    graphCache.set(key, g);
  }
  return g;
}

/**
 * Plans the pick route for an order (pure read + CPU; run OUTSIDE the consumer's write transaction).
 * Routing problems never block fulfilment: a missing layout or location yields 'unplanned' (lines unordered),
 * an optimizer failure yields the S-shape 'fallback', a cold-chain policy that cannot be met yields 'infeasible'
 * with no stops (ADR-006: an infeasible route is never presented as usable).
 */
export async function planTaskForOrder(
  db: PgPool | PgClient,
  orderId: string,
  storeId: number,
  opts: { timeBudgetMs?: number; failOptimizer?: boolean } = {},
): Promise<PlannedTask> {
  const [layoutRes, linesRes] = await Promise.all([
    db.query<{ layout: StoredLayout; version: number }>(
      'SELECT layout, version FROM store_layouts WHERE store_id = $1',
      [storeId],
    ),
    db.query<LineRow>(
      `SELECT l.id, l.sku, p.temperature_zone AS zone, s.aisle, s.pos
         FROM order_lines l
         JOIN products p ON p.sku = l.sku
         LEFT JOIN sku_locations s ON s.store_id = $2 AND s.sku = l.sku
        WHERE l.order_id = $1 ORDER BY l.line_no`,
      [orderId, storeId],
    ),
  ]);
  const lines = linesRes.rows;
  const empty = (reason: string, located: LineRow[] = []): PlannedTask => ({
    routeStatus: 'unplanned',
    route: {
      algorithm: null,
      distanceMeters: null,
      estimatedSeconds: null,
      solveMs: null,
      fallbackUsed: false,
      layout: null,
      stops: [],
      unrouted: lines
        .filter((l) => !located.includes(l))
        .map((l) => ({ orderLineId: l.id, sku: l.sku, reason })),
      reason,
    },
  });
  const stored = layoutRes.rows[0];
  if (!stored) return empty('no_store_layout');
  const layout: StoredLayout = { ...stored.layout, version: stored.version };
  const located = lines.filter((l) => l.aisle !== null && l.pos !== null);
  if (located.length === 0) return empty('no_sku_locations');

  let graph: WarehouseGraph;
  let plan: RoutePlan;
  try {
    graph = graphFor(layout);
    const picks: PickRequest[] = located.map((l) => ({
      id: l.id,
      location: { aisle: l.aisle!, pos: l.pos! },
      zone: l.zone,
    }));
    plan = planRoute(graph, picks, {
      ...(layout.exposureLimits ? { exposureLimits: layout.exposureLimits } : {}),
      ...(opts.timeBudgetMs ? { timeBudgetMs: opts.timeBudgetMs } : {}),
      ...(opts.failOptimizer ? { failOptimizer: true } : {}),
    });
  } catch (e) {
    return empty(`planning_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
  const byId = new Map(located.map((l) => [l.id, l]));
  const unrouted = lines
    .filter((l) => !byId.has(l.id))
    .map((l) => ({ orderLineId: l.id, sku: l.sku, reason: 'no_sku_location' }));
  const base = {
    algorithm: plan.algorithm,
    distanceMeters: plan.distanceMeters,
    estimatedSeconds: plan.estimatedSeconds,
    solveMs: Math.round(plan.solveMs * 100) / 100,
    fallbackUsed: plan.fallbackUsed,
    layout: plan.layout,
  };
  if (plan.status === 'infeasible') {
    return {
      routeStatus: 'infeasible',
      route: {
        ...base,
        algorithm: null,
        stops: [],
        unrouted: lines.map((l) => ({ orderLineId: l.id, sku: l.sku, reason: 'cold_chain_policy_unmet' })),
        reason: `cold-chain exposure policy cannot be met (${plan.violations.length} violation(s)); split or escalate`,
      },
    };
  }
  return {
    routeStatus: plan.fallbackUsed ? 'fallback' : 'feasible',
    route: {
      ...base,
      stops: plan.stops.map((s) => {
        const l = byId.get(s.pickId)!;
        return {
          sequence: s.sequence,
          orderLineId: l.id,
          sku: l.sku,
          aisle: s.location.aisle,
          pos: s.location.pos,
          zone: s.zone,
          arrivalDistanceMeters: s.arrivalDistanceMeters,
          arrivalSeconds: s.arrivalSeconds,
        };
      }),
      unrouted,
      reason: unrouted.length ? `${unrouted.length} line(s) have no bin location` : null,
    },
  };
}

/** Idempotent on order_id: a second creation attempt for the same order is a no-op (returns null). */
export async function createPickTask(
  c: PgClient,
  args: {
    orderId: string;
    storeId: number;
    planned: PlannedTask;
    correlationId: string | null;
    sourceEventId: string;
  },
): Promise<{ id: string } | null> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO pick_tasks (id, order_id, store_id, route_status, route, correlation_id, source_event_id)
     SELECT $1, o.id, o.store_id, $4, $5::jsonb, $6, $7
       FROM orders o WHERE o.id = $2 AND o.store_id = $3 AND o.status IN ('reserved', 'picking')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id`,
    [
      newId(),
      args.orderId,
      args.storeId,
      args.planned.routeStatus,
      JSON.stringify(args.planned.route),
      args.correlationId,
      args.sourceEventId,
    ],
  );
  return r.rows[0] ?? null;
}

/** Order cancelled → its open/claimed task is cancelled (completed tasks are left alone). */
export async function cancelPickTaskForOrder(c: PgClient, orderId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE pick_tasks SET status = 'cancelled', version = version + 1, lease_expires_at = NULL,
            updated_at = clock_timestamp()
      WHERE order_id = $1 AND status IN ('open', 'claimed')`,
    [orderId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Order fully picked → its task is completed (idempotent). */
export async function completePickTaskForOrder(c: PgClient, orderId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE pick_tasks SET status = 'completed', version = version + 1, lease_expires_at = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE order_id = $1 AND status IN ('open', 'claimed')`,
    [orderId],
  );
  return (r.rowCount ?? 0) > 0;
}
