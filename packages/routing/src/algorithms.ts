/**
 * Pick-sequencing algorithms over a distance matrix D where node 0 = entry, nodes 1..n = picks, node n+1 = exit.
 * An "order" is the sequence of pick indices (1..n); the walked path is [0, ...order, n+1].
 * D must be symmetric with non-negative entries (true for the undirected warehouse graph).
 */

export const pathLength = (D: number[][], order: number[]): number => {
  const end = D.length - 1;
  let prev = 0;
  let total = 0;
  for (const i of order) {
    total += D[prev]![i]!;
    prev = i;
  }
  return total + D[prev]![end]!;
};

/** Greedy: always walk to the closest unvisited pick. Ties → lowest index (deterministic). */
export function nearestNeighbour(D: number[][], picks: number[], from = 0): number[] {
  const left = new Set(picks);
  const order: number[] = [];
  let cur = from;
  while (left.size > 0) {
    let best = -1;
    let bestD = Infinity;
    for (const j of left) {
      const d = D[cur]![j]!;
      if (d < bestD || (d === bestD && j < best)) {
        bestD = d;
        best = j;
      }
    }
    order.push(best);
    left.delete(best);
    cur = best;
  }
  return order;
}

export interface TwoOptOptions {
  /** performance.now() deadline; the search stops (keeping its best-so-far) when exceeded. */
  deadline?: number;
  /** Feasibility predicate for constrained improvement; a move is kept only if the new path satisfies it. */
  accept?: (path: number[]) => boolean;
  /** Fixed endpoints of the improvable path (defaults: entry and exit). */
  head?: number;
  tail?: number;
}

/**
 * First-improvement 2-opt on a path with fixed endpoints (same loop structure as the audit prototype, so results
 * are comparable). Never returns a longer route than its input. With `accept`, only feasibility-preserving moves
 * are applied; if the input is feasible the output is feasible.
 */
export function twoOpt(
  D: number[][],
  order: number[],
  opts: TwoOptOptions = {},
): { order: number[]; timedOut: boolean } {
  const head = opts.head ?? 0;
  const tail = opts.tail ?? D.length - 1;
  const path = [head, ...order, tail];
  let improved = true;
  let timedOut = false;
  let checks = 0;
  while (improved) {
    improved = false;
    for (let i = 1; i < path.length - 2; i++) {
      for (let j = i + 1; j < path.length - 1; j++) {
        if (opts.deadline !== undefined && (++checks & 1023) === 0 && performance.now() > opts.deadline) {
          timedOut = true;
          return { order: path.slice(1, -1), timedOut };
        }
        const a = path[i - 1]!;
        const b = path[i]!;
        const c = path[j]!;
        const d = path[j + 1]!;
        if (D[a]![c]! + D[b]![d]! < D[a]![b]! + D[c]![d]! - 1e-9) {
          reverse(path, i, j);
          if (opts.accept && !opts.accept(path)) {
            reverse(path, i, j); // undo: move would violate a constraint
            continue;
          }
          improved = true;
        }
      }
    }
  }
  return { order: path.slice(1, -1), timedOut };
}

/**
 * Or-opt: relocate a segment of 1–3 consecutive picks (optionally reversed) to another position, first improvement.
 * Complements 2-opt: it can move a single cold-chain item to a better slot without reversing long sub-paths.
 * Same `accept` semantics as twoOpt (feasibility-preserving when given).
 */
export function orOpt(
  D: number[][],
  order: number[],
  opts: TwoOptOptions = {},
): { order: number[]; timedOut: boolean } {
  const head = opts.head ?? 0;
  const tail = opts.tail ?? D.length - 1;
  let path = [head, ...order, tail];
  let improved = true;
  let checks = 0;
  while (improved) {
    improved = false;
    outer: for (let k = 1; k <= 3; k++) {
      for (let i = 1; i + k - 1 < path.length - 1; i++) {
        const prev = path[i - 1]!;
        const first = path[i]!;
        const last = path[i + k - 1]!;
        const next = path[i + k]!;
        const removeGain = D[prev]![first]! + D[last]![next]! - D[prev]![next]!;
        if (removeGain <= 1e-9) continue;
        for (let j = 0; j < path.length - 1; j++) {
          if (j >= i - 1 && j <= i + k - 1) continue; // insertion edge must lie outside the segment
          if (opts.deadline !== undefined && (++checks & 1023) === 0 && performance.now() > opts.deadline) {
            return { order: path.slice(1, -1), timedOut: true };
          }
          const a = path[j]!;
          const b = path[j + 1]!;
          for (const rev of [false, true]) {
            const s0 = rev ? last : first;
            const s1 = rev ? first : last;
            const insertCost = D[a]![s0]! + D[s1]![b]! - D[a]![b]!;
            if (insertCost < removeGain - 1e-9) {
              const seg = path.slice(i, i + k);
              if (rev) seg.reverse();
              const rest = [...path.slice(0, i), ...path.slice(i + k)];
              const at = j < i ? j + 1 : j + 1 - k;
              const candidate = [...rest.slice(0, at), ...seg, ...rest.slice(at)];
              if (opts.accept && !opts.accept(candidate)) continue;
              path = candidate;
              improved = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return { order: path.slice(1, -1), timedOut: false };
}

/** Alternates 2-opt and Or-opt until neither improves (or the deadline passes). */
export function localSearch(
  D: number[][],
  order: number[],
  opts: TwoOptOptions = {},
): { order: number[]; timedOut: boolean } {
  let cur = order;
  let best = pathLength(D, cur);
  for (;;) {
    const a = twoOpt(D, cur, opts);
    const b = orOpt(D, a.order, opts);
    const len = pathLength(D, b.order);
    if (a.timedOut || b.timedOut) return { order: len <= best ? b.order : cur, timedOut: true };
    if (len >= best - 1e-9) return { order: len <= best ? b.order : cur, timedOut: false };
    cur = b.order;
    best = len;
  }
}

function reverse(a: number[], i: number, j: number): void {
  while (i < j) {
    const t = a[i]!;
    a[i++] = a[j]!;
    a[j--] = t;
  }
}

/**
 * S-shape (traversal) heuristic: visit aisles that contain picks in increasing aisle order, alternating walking
 * direction. Inputs: for each pick index, its (aisle, pos). Classic baseline. On dense pick lists it measured shorter than
 * 3 s OR-Tools GLS (ADR-006); that is a relative result, not a proof of optimality.
 */
export function sShape(picks: number[], loc: (i: number) => { aisle: number; pos: number }): number[] {
  const byAisle = new Map<number, number[]>();
  for (const p of picks) {
    const a = loc(p).aisle;
    const list = byAisle.get(a);
    if (list) list.push(p);
    else byAisle.set(a, [p]);
  }
  const aisles = [...byAisle.keys()].sort((x, y) => x - y);
  const order: number[] = [];
  aisles.forEach((a, k) => {
    const list = byAisle.get(a)!.sort((p, q) => loc(p).pos - loc(q).pos || p - q);
    order.push(...(k % 2 === 1 ? list.reverse() : list));
  });
  return order;
}

/** Exact optimum by Held–Karp dynamic programming; O(2^n · n²). Only for small n (guarded by the caller). */
export function heldKarp(D: number[][], picks: number[]): number[] {
  const n = picks.length;
  if (n === 0) return [];
  if (n > 16) throw new Error('heldKarp: n too large');
  const end = D.length - 1;
  const full = (1 << n) - 1;
  const cost = new Float64Array((1 << n) * n).fill(Infinity);
  const parent = new Int8Array((1 << n) * n).fill(-1);
  for (let k = 0; k < n; k++) cost[(1 << k) * n + k] = D[0]![picks[k]!]!;
  for (let mask = 1; mask <= full; mask++) {
    for (let k = 0; k < n; k++) {
      if (!(mask & (1 << k))) continue;
      const c = cost[mask * n + k]!;
      if (c === Infinity) continue;
      for (let m = 0; m < n; m++) {
        if (mask & (1 << m)) continue;
        const nm = mask | (1 << m);
        const nc = c + D[picks[k]!]![picks[m]!]!;
        if (nc < cost[nm * n + m]!) {
          cost[nm * n + m] = nc;
          parent[nm * n + m] = k;
        }
      }
    }
  }
  let best = Infinity;
  let last = -1;
  for (let k = 0; k < n; k++) {
    const c = cost[full * n + k]! + D[picks[k]!]![end]!;
    if (c < best) {
      best = c;
      last = k;
    }
  }
  const seq: number[] = [];
  let mask = full;
  while (last >= 0) {
    seq.push(picks[last]!);
    const p = parent[mask * n + last]!;
    mask &= ~(1 << last);
    last = p;
  }
  return seq.reverse();
}
