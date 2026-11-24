/**
 * Exports the TypeScript planner's routes for every prototype instance so OR-Tools can be seeded with them
 * (review item 2). Writes audit/test-results/phase5/ts-planner-routes.json (a NEW file; route-benchmark.* untouched).
 * Routes are node indices into the instance's `nodes` array, depot-to-depot: [0, ..., 0].
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { planRoute, WarehouseGraph, type PickRequest, type WarehouseLayout } from '@aisleforge/routing';

const data = JSON.parse(readFileSync('audit/test-results/phase5/prototype-instances.json', 'utf8')) as {
  layout: {
    aisles: number;
    aisleLength: number;
    aisleSpacing: number;
    crossAisles: number[];
    frozenMaxMeters: number;
  };
  unconstrained: { items: number; seed: number; nodes: [number, number][] }[];
  frozen: { items: number; seed: number; nodes: [number, number][]; frozenIndices: number[] }[];
};
const layout: WarehouseLayout = {
  id: 'audit-prototype',
  version: 1,
  aisles: data.layout.aisles,
  aisleLength: data.layout.aisleLength,
  aisleSpacing: data.layout.aisleSpacing,
  crossAisles: data.layout.crossAisles,
  entry: { aisle: 0, pos: 0 },
  exit: { aisle: 0, pos: 0 },
};

function route(nodes: [number, number][], frozen: Set<number>, limitMeters: number | null) {
  const picks: PickRequest[] = nodes.slice(1).map(([aisle, pos], k) => ({
    id: String(k + 1),
    location: { aisle, pos },
    zone: frozen.has(k + 1) ? 'frozen' : 'ambient',
  }));
  const plan = planRoute(new WarehouseGraph(layout), picks, {
    exposureLimits: limitMeters === null ? [] : [{ zone: 'frozen', maxMeters: limitMeters }],
  });
  if (plan.status !== 'feasible')
    return { status: plan.status, algorithm: null, distanceMeters: null, route: null, solveMs: plan.solveMs };
  return {
    status: plan.status,
    algorithm: plan.algorithm,
    distanceMeters: plan.distanceMeters,
    solveMs: plan.solveMs,
    route: [0, ...plan.stops.map((s) => Number(s.pickId)), 0],
  };
}

const out = {
  recordedAt: new Date().toISOString(),
  note: 'TypeScript planner (default options, 250 ms budget) routes for the prototype instances; input for OR-Tools seeding.',
  unconstrained: data.unconstrained.map((i) => ({
    items: i.items,
    seed: i.seed,
    ...route(i.nodes, new Set(), null),
  })),
  frozen: data.frozen.map((i) => ({
    items: i.items,
    seed: i.seed,
    ...route(i.nodes, new Set(i.frozenIndices), data.layout.frozenMaxMeters),
  })),
};
writeFileSync('audit/test-results/phase5/ts-planner-routes.json', JSON.stringify(out));
console.log(
  'exported',
  out.unconstrained.length,
  'unconstrained and',
  out.frozen.length,
  'frozen routes;',
  'infeasible:',
  [...out.unconstrained, ...out.frozen].filter((r) => r.status !== 'feasible').length,
);
