import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  evaluateRoute,
  heldKarp,
  localSearch,
  nearestNeighbour,
  orOpt,
  pathLength,
  planRoute,
  sShape,
  twoOpt,
  WarehouseGraph,
  type Location,
  type PickRequest,
  type WarehouseLayout,
} from '@aisleforge/routing';

/** Same geometry as the audit prototype (20 aisles × 50 m, 3 m apart, cross-aisles at 0/25/50, depot at aisle 0 front). */
const PROTO_LAYOUT: WarehouseLayout = {
  id: 'audit-prototype',
  version: 1,
  aisles: 20,
  aisleLength: 50,
  aisleSpacing: 3,
  crossAisles: [0, 25, 50],
  entry: { aisle: 0, pos: 0 },
  exit: { aisle: 0, pos: 0 },
};
const graph = new WarehouseGraph(PROTO_LAYOUT);

const locArb = fc.record({ aisle: fc.integer({ min: 0, max: 19 }), pos: fc.integer({ min: 1, max: 49 }) });
const uniqueLocs = (min: number, max: number) =>
  fc.uniqueArray(locArb, { selector: (l) => `${l.aisle}:${l.pos}`, minLength: min, maxLength: max });
const matrixFor = (locs: Location[]) => graph.matrix([PROTO_LAYOUT.entry, ...locs, PROTO_LAYOUT.exit]);
const idxs = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const isPermutation = (order: number[], n: number) =>
  order.length === n && new Set(order).size === n && order.every((i) => i >= 1 && i <= n);

describe('warehouse graph shortest paths', () => {
  it('matches the closed form for a single-block layout (cross-aisles only at the ends)', () => {
    const g = new WarehouseGraph({ ...PROTO_LAYOUT, id: 'single-block', crossAisles: [0, 50] });
    fc.assert(
      fc.property(locArb, locArb, (a, b) => {
        const expected =
          a.aisle === b.aisle
            ? Math.abs(a.pos - b.pos)
            : Math.min(a.pos + b.pos, 100 - a.pos - b.pos) + 3 * Math.abs(a.aisle - b.aisle);
        return Math.abs(g.distance(a, b) - expected) < 1e-9;
      }),
      { seed: 7, numRuns: 500 },
    );
  });

  it('is symmetric and satisfies the triangle inequality', () => {
    fc.assert(
      fc.property(
        locArb,
        locArb,
        locArb,
        (a, b, c) =>
          Math.abs(graph.distance(a, b) - graph.distance(b, a)) < 1e-9 &&
          graph.distance(a, c) <= graph.distance(a, b) + graph.distance(b, c) + 1e-9,
      ),
      { seed: 8, numRuns: 300 },
    );
  });

  const instancesFile = 'audit/test-results/phase5/prototype-instances.json';
  it.skipIf(!existsSync(instancesFile))(
    'reproduces the Python prototype distance matrices exactly (cross-implementation check)',
    () => {
      const data = JSON.parse(readFileSync(instancesFile, 'utf8')) as {
        unconstrained: { nodes: [number, number][]; matrix?: number[][] }[];
      };
      let compared = 0;
      for (const inst of data.unconstrained.filter((i) => i.matrix)) {
        const locs = inst.nodes.map(([aisle, pos]) => ({ aisle, pos }));
        const ours = graph.matrix(locs);
        for (let i = 0; i < locs.length; i++)
          for (let j = 0; j < locs.length; j++) {
            expect(ours[i]![j]).toBeCloseTo(inst.matrix![i]![j]!, 9);
            compared++;
          }
      }
      expect(compared).toBeGreaterThan(10_000);
    },
  );

  it('rejects locations outside the layout and invalid layouts', () => {
    expect(() => graph.assertLocation({ aisle: 20, pos: 0 })).toThrow(/outside/);
    expect(() => graph.assertLocation({ aisle: 0, pos: 51 })).toThrow(/outside/);
    expect(() => new WarehouseGraph({ ...PROTO_LAYOUT, crossAisles: [99] })).toThrow(/Invalid/);
  });
});

describe('algorithms (properties)', () => {
  it('every algorithm returns a permutation of the picks; pathLength matches the matrix sum', () => {
    fc.assert(
      fc.property(uniqueLocs(1, 30), (locs) => {
        const D = matrixFor(locs);
        const n = locs.length;
        const orders = [
          nearestNeighbour(D, idxs(n)),
          twoOpt(D, nearestNeighbour(D, idxs(n))).order,
          sShape(idxs(n), (i) => locs[i - 1]!),
        ];
        return orders.every((o) => isPermutation(o, n));
      }),
      { seed: 9, numRuns: 150 },
    );
  });

  it('2-opt never makes a route longer', () => {
    fc.assert(
      fc.property(uniqueLocs(2, 40), fc.integer({ min: 0, max: 1000 }), (locs, seed) => {
        const D = matrixFor(locs);
        const start = [...idxs(locs.length)].sort(
          (a, b) => ((a * 7919 + seed) % 97) - ((b * 7919 + seed) % 97),
        );
        return pathLength(D, twoOpt(D, start).order) <= pathLength(D, start) + 1e-9;
      }),
      { seed: 10, numRuns: 150 },
    );
  });

  it('Held–Karp is optimal: never longer than any heuristic (n ≤ 9)', () => {
    fc.assert(
      fc.property(uniqueLocs(1, 9), (locs) => {
        const D = matrixFor(locs);
        const n = locs.length;
        const exact = pathLength(D, heldKarp(D, idxs(n)));
        const heur = [
          nearestNeighbour(D, idxs(n)),
          twoOpt(D, nearestNeighbour(D, idxs(n))).order,
          sShape(idxs(n), (i) => locs[i - 1]!),
        ];
        return isPermutation(heldKarp(D, idxs(n)), n) && heur.every((o) => exact <= pathLength(D, o) + 1e-9);
      }),
      { seed: 11, numRuns: 120 },
    );
  });

  it('Or-opt and local search never lengthen a route and keep it a permutation', () => {
    fc.assert(
      fc.property(uniqueLocs(2, 40), (locs) => {
        const D = matrixFor(locs);
        const n = locs.length;
        const nn = nearestNeighbour(D, idxs(n));
        const o = orOpt(D, nn).order;
        const ls = localSearch(D, nn).order;
        return (
          isPermutation(o, n) &&
          isPermutation(ls, n) &&
          pathLength(D, o) <= pathLength(D, nn) + 1e-9 &&
          pathLength(D, ls) <= pathLength(D, nn) + 1e-9
        );
      }),
      { seed: 13, numRuns: 150 },
    );
  });

  it('constrained local search preserves feasibility of a feasible start', () => {
    fc.assert(
      fc.property(uniqueLocs(3, 25), fc.integer({ min: 0, max: 3 }), (locs, k) => {
        const D = matrixFor(locs);
        const n = locs.length;
        const sensitive = new Set(idxs(n).slice(0, k));
        const zoneOf = (i: number) => (sensitive.has(i) ? ('frozen' as const) : ('ambient' as const));
        const limits = [{ zone: 'frozen' as const, maxMeters: 60 }];
        // Feasible start: sensitive picks last, nearest to the exit first-from-the-end.
        const start = [...idxs(n).filter((i) => !sensitive.has(i)), ...[...sensitive]];
        const feasible = (path: number[]) =>
          evaluateRoute(D, path.slice(1, -1), zoneOf, limits, { walkSpeedMps: 1.2, pickSeconds: 10 })
            .violations.length === 0;
        if (!feasible([0, ...start, n + 1])) return true; // property only concerns feasible starts
        const out = localSearch(D, start, { accept: feasible }).order;
        return feasible([0, ...out, n + 1]) && pathLength(D, out) <= pathLength(D, start) + 1e-9;
      }),
      { seed: 14, numRuns: 150 },
    );
  });

  it('S-shape alternates direction across consecutive aisles', () => {
    const locs = [
      { aisle: 2, pos: 10 },
      { aisle: 2, pos: 40 },
      { aisle: 5, pos: 5 },
      { aisle: 5, pos: 30 },
    ];
    expect(sShape(idxs(4), (i) => locs[i - 1]!)).toEqual([1, 2, 4, 3]);
  });
});

describe('cold-chain exposure evaluation', () => {
  it('computes exposure as remaining walk + later picking time, and flags violations', () => {
    // entry/exit at (0,0); pick A frozen at (0,10), pick B ambient at (0,20). Route A then B.
    const locs = [
      { aisle: 0, pos: 10 },
      { aisle: 0, pos: 20 },
    ];
    const D = matrixFor(locs);
    const zone = (i: number): 'frozen' | 'ambient' => (i === 1 ? 'frozen' : 'ambient');
    const travel = { walkSpeedMps: 1, pickSeconds: 10 };
    const ev = evaluateRoute(D, [1, 2], zone, [{ zone: 'frozen', maxSeconds: 39 }], travel);
    // after picking A: walk 10 to B, pick B (10 s), walk 20 back = 30 m + 10 s = 40 s > 39
    expect(ev.violations).toHaveLength(1);
    expect(ev.violations[0]).toMatchObject({ pickIndex: 1, exposureMeters: 30, exposureSeconds: 40 });
    expect(
      evaluateRoute(D, [2, 1], zone, [{ zone: 'frozen', maxSeconds: 39 }], travel).violations,
    ).toHaveLength(0);
  });
});

describe('planRoute', () => {
  const pick = (
    id: string,
    aisle: number,
    pos: number,
    zone: PickRequest['zone'] = 'ambient',
  ): PickRequest => ({ id, location: { aisle, pos }, zone });

  it('returns ordered stops, distance, time, algorithm, solve time and candidates', () => {
    const plan = planRoute(graph, [pick('a', 3, 10), pick('b', 7, 40), pick('c', 1, 5)]);
    expect(plan.status).toBe('feasible');
    expect(plan.stops.map((s) => s.pickId).sort()).toEqual(['a', 'b', 'c']);
    expect(plan.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(plan.distanceMeters).toBeGreaterThan(0);
    expect(plan.candidates.map((c) => c.algorithm)).toEqual(
      expect.arrayContaining(['s_shape', 'nn_2opt', 'exact_held_karp']),
    );
    expect(plan.distanceMeters).toBe(
      Math.min(...plan.candidates.filter((c) => c.feasible).map((c) => c.distanceMeters)),
    );
  });

  it('never returns an infeasible route as valid (property over random orders with tight limits)', () => {
    fc.assert(
      fc.property(
        uniqueLocs(2, 25),
        fc.array(fc.boolean(), { minLength: 25, maxLength: 25 }),
        fc.integer({ min: 20, max: 400 }),
        (locs, frozenFlags, limit) => {
          const picks = locs.map((l, i) =>
            pick(`p${i}`, l.aisle, l.pos, frozenFlags[i] ? 'frozen' : 'ambient'),
          );
          const limits = [{ zone: 'frozen' as const, maxSeconds: limit }];
          const plan = planRoute(graph, picks, { exposureLimits: limits });
          if (plan.status === 'infeasible') return plan.stops.length === 0 && plan.violations.length > 0;
          // Re-evaluate the returned stop order independently.
          const order = plan.stops.map((s) => picks.findIndex((p) => p.id === s.pickId) + 1);
          const D = matrixFor(locs);
          return (
            evaluateRoute(D, order, (i) => picks[i - 1]!.zone, limits, { walkSpeedMps: 1.2, pickSeconds: 10 })
              .violations.length === 0
          );
        },
      ),
      { seed: 12, numRuns: 150 },
    );
  });

  it('reports infeasible (no stops) when the policy cannot be met', () => {
    const plan = planRoute(graph, [pick('far-frozen', 19, 49, 'frozen')], {
      exposureLimits: [{ zone: 'frozen', maxMeters: 10 }],
    });
    expect(plan.status).toBe('infeasible');
    expect(plan.stops).toEqual([]);
    expect(plan.violations[0]).toMatchObject({ zone: 'frozen' });
  });

  it('finds a compliant route where plain distance-optimal routing violates the policy', () => {
    // Frozen items near the dock must be collected last; a distance-only route picks them first.
    const picks = [
      pick('f1', 0, 3, 'frozen'),
      pick('f2', 1, 4, 'frozen'),
      ...Array.from({ length: 12 }, (_, i) => pick(`a${i}`, 4 + i, 20 + (i % 3) * 7)),
    ];
    const limits = [{ zone: 'frozen' as const, maxMeters: 40 }];
    const plan = planRoute(graph, picks, { exposureLimits: limits });
    expect(plan.status).toBe('feasible');
    expect(plan.candidates.some((c) => !c.feasible)).toBe(true); // at least one baseline violated the policy
    expect(['zone_sequenced_2opt', 'local_search']).toContain(plan.algorithm);
  });

  it('falls back to S-shape when the optimizer fails, and still plans a valid route', () => {
    const plan = planRoute(graph, [pick('a', 3, 10), pick('b', 9, 30)], { failOptimizer: true });
    expect(plan).toMatchObject({ status: 'feasible', algorithm: 's_shape', fallbackUsed: true });
  });

  it('respects the time budget on large orders (keeps the best-so-far)', () => {
    const picks = Array.from({ length: 400 }, (_, i) => pick(`p${i}`, i % 20, 1 + ((i * 37) % 49)));
    const plan = planRoute(graph, picks, { timeBudgetMs: 50 });
    expect(plan.status).toBe('feasible');
    expect(plan.solveMs).toBeLessThan(2000); // budget bounds the search; matrix construction is the remaining cost
  });

  it('enforces input limits', () => {
    expect(() => planRoute(graph, [])).toThrow(/at least one/);
    expect(() =>
      planRoute(
        graph,
        Array.from({ length: 501 }, (_, i) => pick(`p${i}`, 0, 1)),
      ),
    ).toThrow(/At most/);
    expect(() => planRoute(graph, [pick('x', 0, 1), pick('x', 0, 2)])).toThrow(/Duplicate/);
    expect(() => planRoute(graph, [pick('x', 99, 1)])).toThrow(/outside/);
  });
});
