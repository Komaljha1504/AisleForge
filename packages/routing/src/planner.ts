import { AppError } from '@aisleforge/shared';
import { heldKarp, localSearch, nearestNeighbour, sShape, twoOpt } from './algorithms';
import {
  evaluateRoute,
  type ExposureLimit,
  type RouteEvaluation,
  type TravelModel,
  type Violation,
} from './constraints';
import type { Location, TemperatureZone, WarehouseGraph } from './graph';

export interface PickRequest {
  /** Caller's id for the pick line (e.g. reservation id). */
  id: string;
  location: Location;
  zone: TemperatureZone;
}

export interface PlanOptions {
  travel?: TravelModel;
  exposureLimits?: ExposureLimit[];
  /** Total solve budget. Candidates that would exceed it are cut short (best-so-far kept). */
  timeBudgetMs?: number;
  /** Orders at or below this size are also solved exactly (Held–Karp) when unconstrained. */
  exactThreshold?: number;
  maxPicks?: number;
  /** Test hook: force an optimizer failure to exercise the fallback path. */
  failOptimizer?: boolean;
}

export type AlgorithmName =
  's_shape' | 'nn_2opt' | 'exact_held_karp' | 'zone_sequenced_2opt' | 'local_search';

export interface CandidateSummary {
  algorithm: AlgorithmName;
  distanceMeters: number;
  estimatedSeconds: number;
  feasible: boolean;
  violations: number;
  timedOut: boolean;
}

export interface PlannedStop {
  sequence: number;
  pickId: string;
  location: Location;
  zone: TemperatureZone;
  arrivalDistanceMeters: number;
  arrivalSeconds: number;
}

export interface RoutePlan {
  /** 'infeasible' plans carry NO stops: an infeasible route is never presented as usable. */
  status: 'feasible' | 'infeasible';
  algorithm: AlgorithmName | null;
  stops: PlannedStop[];
  distanceMeters: number | null;
  estimatedSeconds: number | null;
  solveMs: number;
  fallbackUsed: boolean;
  candidates: CandidateSummary[];
  /** For infeasible plans: the violations of the least-bad candidate, to explain the rejection. */
  violations: Violation[];
  layout: { id: string; version: number };
}

export const DEFAULT_TRAVEL: TravelModel = { walkSpeedMps: 1.2, pickSeconds: 10 };
/** Example operating policy (configurable per deployment): chilled ≤ 20 min, frozen ≤ 10 min to hand-off. */
export const DEFAULT_EXPOSURE_LIMITS: ExposureLimit[] = [
  { zone: 'chilled', maxSeconds: 20 * 60 },
  { zone: 'frozen', maxSeconds: 10 * 60 },
];

/**
 * Plans a single picker's route.
 *
 * Candidates: S-shape (always, cheap — also the fallback), nearest-neighbour + 2-opt, exact Held–Karp for small
 * orders, and — when temperature-sensitive items exist — a zone-sequenced construction improved by
 * feasibility-preserving 2-opt. The shortest FEASIBLE candidate wins. If no candidate satisfies the exposure policy,
 * the plan is 'infeasible' and has no stops (callers must split the batch, or escalate).
 * Audit evidence that shaped this: NN+2-opt is within ~1–3% of OR-Tools; S-shape wins on dense orders; unseeded
 * constrained OR-Tools failed on 14/15 feasible instances while a feasible heuristic seed solved all of them.
 */
export function planRoute(graph: WarehouseGraph, picks: PickRequest[], opts: PlanOptions = {}): RoutePlan {
  const t0 = performance.now();
  const travel = opts.travel ?? DEFAULT_TRAVEL;
  const limits = opts.exposureLimits ?? DEFAULT_EXPOSURE_LIMITS;
  const budget = opts.timeBudgetMs ?? 250;
  const deadline = t0 + budget;
  const maxPicks = opts.maxPicks ?? 500;
  const exactThreshold = Math.min(opts.exactThreshold ?? 12, 12);

  if (picks.length === 0) throw new AppError('VALIDATION_FAILED', 'A route needs at least one pick');
  if (picks.length > maxPicks) throw new AppError('VALIDATION_FAILED', `At most ${maxPicks} picks per route`);
  if (new Set(picks.map((p) => p.id)).size !== picks.length)
    throw new AppError('VALIDATION_FAILED', 'Duplicate pick ids');
  for (const p of picks) graph.assertLocation(p.location);

  const { entry, exit } = graph.layout;
  const points = [entry, ...picks.map((p) => p.location), exit];
  const D = graph.matrix(points);
  const idx = picks.map((_, i) => i + 1);
  const zoneOf = (i: number): TemperatureZone => picks[i - 1]!.zone;
  const sensitiveZones = new Set(limits.map((l) => l.zone));
  const sensitive = idx.filter((i) => sensitiveZones.has(zoneOf(i)));
  const evaluate = (order: number[]): RouteEvaluation => evaluateRoute(D, order, zoneOf, limits, travel);
  const isFeasiblePath = (path: number[]): boolean => evaluate(path.slice(1, -1)).violations.length === 0;

  const results: { algorithm: AlgorithmName; order: number[]; ev: RouteEvaluation; timedOut: boolean }[] = [];
  const add = (algorithm: AlgorithmName, order: number[], timedOut = false) =>
    results.push({ algorithm, order, ev: evaluate(order), timedOut });

  // 1. S-shape: always computed first; it is the deterministic fallback.
  add(
    's_shape',
    sShape(idx, (i) => picks[i - 1]!.location),
  );

  let fallbackUsed = false;
  try {
    if (opts.failOptimizer) throw new Error('optimizer failure (injected)');
    // 2. Nearest-neighbour + 2-opt (time-bounded).
    const nn = nearestNeighbour(D, idx);
    const improved = twoOpt(D, nn, { deadline });
    add('nn_2opt', improved.order, improved.timedOut);
    // 3. Exact for small orders.
    if (idx.length <= exactThreshold && performance.now() < deadline)
      add('exact_held_karp', heldKarp(D, idx));
    // 4. Constraint-aware construction when the policy applies to some picks.
    if (sensitive.length > 0 && performance.now() < deadline) {
      const z = zoneSequenced(D, idx, sensitive, deadline, isFeasiblePath);
      add('zone_sequenced_2opt', z.order, z.timedOut);
    }
    // 5. Improve the best feasible candidate with 2-opt + Or-opt (feasibility-preserving), within the budget.
    const bestSoFar = results
      .filter((r) => r.ev.violations.length === 0)
      .sort((a, b) => a.ev.distanceMeters - b.ev.distanceMeters)[0];
    if (bestSoFar && bestSoFar.algorithm !== 'exact_held_karp' && performance.now() < deadline) {
      const ls = localSearch(D, bestSoFar.order, {
        deadline,
        ...(sensitive.length > 0 ? { accept: isFeasiblePath } : {}),
      });
      add('local_search', ls.order, ls.timedOut);
    }
  } catch {
    fallbackUsed = true; // S-shape candidate already exists; never block picking on optimizer problems
  }

  const candidates: CandidateSummary[] = results.map((r) => ({
    algorithm: r.algorithm,
    distanceMeters: round(r.ev.distanceMeters),
    estimatedSeconds: round(r.ev.estimatedSeconds),
    feasible: r.ev.violations.length === 0,
    violations: r.ev.violations.length,
    timedOut: r.timedOut,
  }));
  const feasible = results
    .filter((r) => r.ev.violations.length === 0)
    .sort((a, b) => a.ev.distanceMeters - b.ev.distanceMeters);
  const solveMs = round(performance.now() - t0);
  const layout = { id: graph.layout.id, version: graph.layout.version };

  const best = feasible[0];
  if (!best) {
    const leastBad = [...results].sort(
      (a, b) => a.ev.violations.length - b.ev.violations.length || a.ev.distanceMeters - b.ev.distanceMeters,
    )[0]!;
    return {
      status: 'infeasible',
      algorithm: null,
      stops: [],
      distanceMeters: null,
      estimatedSeconds: null,
      solveMs,
      fallbackUsed,
      candidates,
      violations: leastBad.ev.violations,
      layout,
    };
  }
  return {
    status: 'feasible',
    algorithm: best.algorithm,
    stops: best.ev.arrivals.map((a, k) => ({
      sequence: k + 1,
      pickId: picks[a.pickIndex - 1]!.id,
      location: picks[a.pickIndex - 1]!.location,
      zone: zoneOf(a.pickIndex),
      arrivalDistanceMeters: round(a.distanceMeters),
      arrivalSeconds: round(a.seconds),
    })),
    distanceMeters: round(best.ev.distanceMeters),
    estimatedSeconds: round(best.ev.estimatedSeconds),
    solveMs,
    fallbackUsed,
    candidates,
    violations: [],
    layout,
  };
}

/**
 * Constraint-aware construction: non-sensitive picks first (NN + 2-opt between the entry and the first sensitive
 * pick), then sensitive picks ordered by nearest-neighbour built backwards from the exit, then whole-route 2-opt that
 * only accepts moves preserving feasibility. This mirrors the "feasible seed" that let OR-Tools solve the audit's
 * frozen instances, but runs in-process.
 */
function zoneSequenced(
  D: number[][],
  all: number[],
  sensitive: number[],
  deadline: number,
  accept: (path: number[]) => boolean,
): { order: number[]; timedOut: boolean } {
  const end = D.length - 1;
  const sens = new Set(sensitive);
  const ambient = all.filter((i) => !sens.has(i));
  const backwards = nearestNeighbour(D, sensitive, end);
  const sensitiveSuffix = backwards.reverse();
  const head = sensitiveSuffix[0] ?? end;
  const ambientOrder =
    ambient.length > 1
      ? twoOpt(D, nearestNeighbour(D, ambient), { deadline, head: 0, tail: head }).order
      : ambient;
  const seed = [...ambientOrder, ...sensitiveSuffix];
  if (!accept([0, ...seed, end])) return { order: seed, timedOut: false }; // reported as infeasible by the caller
  return twoOpt(D, seed, { deadline, accept });
}

const round = (x: number): number => Math.round(x * 10) / 10;
