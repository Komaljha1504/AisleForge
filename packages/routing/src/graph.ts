import { AppError } from '@aisleforge/shared';

/** A location in a parallel-aisle store/warehouse: aisle index and metres along the aisle (integer). */
export interface Location {
  aisle: number;
  pos: number;
}

export type TemperatureZone = 'ambient' | 'chilled' | 'frozen';

export interface WarehouseLayout {
  id: string;
  version: number;
  aisles: number;
  /** Aisle length in metres; positions are integers in [0, aisleLength]. */
  aisleLength: number;
  /** Centre-to-centre aisle distance in metres. */
  aisleSpacing: number;
  /** Positions (metres) of cross-aisles connecting adjacent aisles; must include 0 and/or aisleLength to be connected. */
  crossAisles: number[];
  /** Where pickers start (entry) and where picked items are handed off (exit / pack-out / cold chain handoff). */
  entry: Location;
  exit: Location;
}

/**
 * Graph of walkable segments: one node per (aisle, integer metre), unit edges along aisles, `aisleSpacing` edges
 * between adjacent aisles at each cross-aisle. Shortest paths by Dijkstra (non-negative weights).
 * Distances from a source are cached per layout version, because store layouts change rarely and the same bins
 * are visited repeatedly (audit §7: precompute distances per layout version).
 */
export class WarehouseGraph {
  readonly nodeCount: number;
  private readonly adjOffsets: Int32Array;
  private readonly adjTargets: Int32Array;
  private readonly adjWeights: Float64Array;
  private readonly cache = new Map<number, Float64Array>();

  constructor(
    readonly layout: WarehouseLayout,
    private readonly maxCachedSources = 5000,
  ) {
    validateLayout(layout);
    const L = layout.aisleLength;
    this.nodeCount = layout.aisles * (L + 1);
    const edges: [number, number, number][] = [];
    for (let a = 0; a < layout.aisles; a++)
      for (let y = 0; y < L; y++)
        edges.push([this.id({ aisle: a, pos: y }), this.id({ aisle: a, pos: y + 1 }), 1]);
    for (let a = 0; a < layout.aisles - 1; a++)
      for (const y of layout.crossAisles)
        edges.push([this.id({ aisle: a, pos: y }), this.id({ aisle: a + 1, pos: y }), layout.aisleSpacing]);
    // CSR adjacency (undirected)
    const degree = new Int32Array(this.nodeCount);
    for (const [u, v] of edges) {
      degree[u]!++;
      degree[v]!++;
    }
    this.adjOffsets = new Int32Array(this.nodeCount + 1);
    for (let i = 0; i < this.nodeCount; i++) this.adjOffsets[i + 1] = this.adjOffsets[i]! + degree[i]!;
    this.adjTargets = new Int32Array(this.adjOffsets[this.nodeCount]!);
    this.adjWeights = new Float64Array(this.adjOffsets[this.nodeCount]!);
    const fill = this.adjOffsets.slice(0, this.nodeCount);
    for (const [u, v, w] of edges) {
      this.adjTargets[fill[u]!] = v;
      this.adjWeights[fill[u]!++] = w;
      this.adjTargets[fill[v]!] = u;
      this.adjWeights[fill[v]!++] = w;
    }
  }

  id(l: Location): number {
    return l.aisle * (this.layout.aisleLength + 1) + l.pos;
  }

  assertLocation(l: Location): void {
    if (
      !Number.isInteger(l.aisle) ||
      !Number.isInteger(l.pos) ||
      l.aisle < 0 ||
      l.aisle >= this.layout.aisles ||
      l.pos < 0 ||
      l.pos > this.layout.aisleLength
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Location (${l.aisle}, ${l.pos}) is outside layout ${this.layout.id}`,
      );
    }
  }

  /** Single-source shortest distances (binary-heap Dijkstra), cached. */
  distancesFrom(l: Location): Float64Array {
    const src = this.id(l);
    const hit = this.cache.get(src);
    if (hit) return hit;
    const dist = new Float64Array(this.nodeCount).fill(Infinity);
    dist[src] = 0;
    const heap = new MinHeap();
    heap.push(0, src);
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > dist[u]!) continue;
      for (let k = this.adjOffsets[u]!; k < this.adjOffsets[u + 1]!; k++) {
        const v = this.adjTargets[k]!;
        const nd = d + this.adjWeights[k]!;
        if (nd < dist[v]!) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    if (this.cache.size >= this.maxCachedSources) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(src, dist);
    return dist;
  }

  distance(a: Location, b: Location): number {
    return this.distancesFrom(a)[this.id(b)]!;
  }

  /** Full matrix for an ordered list of locations. */
  matrix(points: Location[]): number[][] {
    const ids = points.map((p) => this.id(p));
    return points.map((p) => {
      const d = this.distancesFrom(p);
      return ids.map((i) => d[i]!);
    });
  }
}

function validateLayout(l: WarehouseLayout): void {
  const ok =
    Number.isInteger(l.aisles) &&
    l.aisles >= 1 &&
    l.aisles <= 500 &&
    Number.isInteger(l.aisleLength) &&
    l.aisleLength >= 1 &&
    l.aisleLength <= 1000 &&
    l.aisleSpacing > 0 &&
    l.crossAisles.length >= 1 &&
    l.crossAisles.every((y) => Number.isInteger(y) && y >= 0 && y <= l.aisleLength);
  if (!ok) throw new AppError('VALIDATION_FAILED', `Invalid warehouse layout ${l.id}`);
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(k: number, v: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): [number, number] {
    const keys = this.keys;
    const vals = this.vals;
    const topK = keys[0]!;
    const topV = vals[0]!;
    const lastK = keys.pop()!;
    const lastV = vals.pop()!;
    if (keys.length > 0) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[c]! >= lastK) break;
        keys[i] = keys[c]!;
        vals[i] = vals[c]!;
        i = c;
      }
      keys[i] = lastK;
      vals[i] = lastV;
    }
    return [topK, topV];
  }
}
