import type { TemperatureZone } from './graph';

/**
 * Cold-chain exposure policy: the maximum time (and/or walking distance) an item of a zone may spend between being
 * picked and reaching the hand-off/exit point. This models the operating rule directly instead of hard-coding an
 * "ambient → chilled → frozen" sequence — a sequence that is often feasible-but-wasteful or still non-compliant.
 */
export interface ExposureLimit {
  zone: TemperatureZone;
  maxSeconds?: number;
  maxMeters?: number;
}

export interface TravelModel {
  walkSpeedMps: number;
  pickSeconds: number;
}

export interface Violation {
  pickIndex: number;
  zone: TemperatureZone;
  exposureSeconds: number;
  exposureMeters: number;
  limitSeconds: number | null;
  limitMeters: number | null;
}

export interface RouteEvaluation {
  distanceMeters: number;
  estimatedSeconds: number;
  violations: Violation[];
  /** Cumulative distance/time on arrival at each pick (same order as the route). */
  arrivals: { pickIndex: number; distanceMeters: number; seconds: number }[];
}

/**
 * Evaluates a full path [0, ...order, end]. Exposure of a pick = walking from it to the exit plus the picking time of
 * every later pick (the item rides in the tote meanwhile). The pick's own picking time happens before exposure starts.
 */
export function evaluateRoute(
  D: number[][],
  order: number[],
  zoneOf: (pickIndex: number) => TemperatureZone,
  limits: ExposureLimit[],
  travel: TravelModel,
): RouteEvaluation {
  const end = D.length - 1;
  const arrivals: RouteEvaluation['arrivals'] = [];
  let acc = 0;
  let prev = 0;
  order.forEach((p, k) => {
    acc += D[prev]![p]!;
    arrivals.push({
      pickIndex: p,
      distanceMeters: acc,
      seconds: acc / travel.walkSpeedMps + k * travel.pickSeconds,
    });
    prev = p;
  });
  const total = acc + D[prev]![end]!;
  const estimatedSeconds = total / travel.walkSpeedMps + order.length * travel.pickSeconds;
  const limitByZone = new Map(limits.map((l) => [l.zone, l]));
  const violations: Violation[] = [];
  arrivals.forEach((a, k) => {
    const zone = zoneOf(a.pickIndex);
    const lim = limitByZone.get(zone);
    if (!lim) return;
    const exposureMeters = total - a.distanceMeters;
    const laterPicks = order.length - 1 - k;
    const exposureSeconds = exposureMeters / travel.walkSpeedMps + laterPicks * travel.pickSeconds;
    const overMeters = lim.maxMeters !== undefined && exposureMeters > lim.maxMeters + 1e-9;
    const overSeconds = lim.maxSeconds !== undefined && exposureSeconds > lim.maxSeconds + 1e-9;
    if (overMeters || overSeconds) {
      violations.push({
        pickIndex: a.pickIndex,
        zone,
        exposureSeconds,
        exposureMeters,
        limitSeconds: lim.maxSeconds ?? null,
        limitMeters: lim.maxMeters ?? null,
      });
    }
  });
  return { distanceMeters: total, estimatedSeconds, violations, arrivals };
}
