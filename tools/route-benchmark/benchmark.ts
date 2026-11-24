/**
 * Phase 5 benchmark: AisleForge TypeScript route planner vs the audit prototype (Python + OR-Tools) on the
 * IDENTICAL instances exported by export_prototype_instances.py.
 *
 *   pnpm tsx tools/route-benchmark/benchmark.ts
 *
 * Writes audit/test-results/phase5/route-benchmark.json and route-benchmark.md. Every number is measured here or
 * copied verbatim from the prototype's exported per-instance results (labelled "prototype").
 */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import {
  heldKarp,
  nearestNeighbour,
  pathLength,
  planRoute,
  sShape,
  twoOpt,
  WarehouseGraph,
  type PickRequest,
  type WarehouseLayout,
} from '@aisleforge/routing';

interface UncInstance {
  items: number;
  seed: number;
  nodes: [number, number][];
  reference: Record<string, number>;
}
interface FrozenRef {
  distance: number;
  violations: number;
}
interface FrozenInstance {
  items: number;
  seed: number;
  nodes: [number, number][];
  frozenIndices: number[];
  reference: Record<string, FrozenRef | null>;
}
const data = JSON.parse(readFileSync('audit/test-results/phase5/prototype-instances.json', 'utf8')) as {
  layout: {
    aisles: number;
    aisleLength: number;
    aisleSpacing: number;
    crossAisles: number[];
    frozenMaxMeters: number;
  };
  unconstrained: UncInstance[];
  frozen: FrozenInstance[];
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
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const gapPct = (x: number, ref: number) => (x / ref - 1) * 100;

// ---------------- unconstrained ----------------
const byN = new Map<number, UncInstance[]>();
for (const i of data.unconstrained) byN.set(i.items, [...(byN.get(i.items) ?? []), i]);
const unconstrainedRows = [];
for (const [n, insts] of byN) {
  const acc: Record<string, number[]> = {};
  const push = (k: string, v: number) => (acc[k] ??= []).push(v);
  let nnMatches = 0,
    sMatches = 0,
    twoOptMatches = 0,
    twoOptCompared = 0;
  for (const inst of insts) {
    const graph = new WarehouseGraph(layout); // cold cache per instance: worst-case solve time
    const locs = inst.nodes.slice(1).map(([aisle, pos]) => ({ aisle, pos }));
    const ref = inst.reference;
    const refBest = ref.exact_held_karp ?? ref.ortools_gls_3s!;
    const t0 = performance.now();
    const D = graph.matrix([layout.entry, ...locs, layout.exit]);
    push('matrix_ms', performance.now() - t0);
    const idx = locs.map((_, k) => k + 1);
    const nn = nearestNeighbour(D, idx);
    const ts = {
      nn: pathLength(D, nn),
      s: pathLength(
        D,
        sShape(idx, (k) => locs[k - 1]!),
      ),
    } as Record<string, number>;
    if (Math.abs(ts.nn! - ref.nearest_neighbour!) < 1e-6) nnMatches++;
    if (Math.abs(ts.s! - ref.s_shape!) < 1e-6) sMatches++;
    if (n <= 200) {
      ts.nn2 = pathLength(D, twoOpt(D, nn).order);
      twoOptCompared++;
      if (Math.abs(ts.nn2 - ref.nn_2opt!) < 1e-6) twoOptMatches++;
    }
    if (n <= 12) ts.exact = pathLength(D, heldKarp(D, idx));
    const picks: PickRequest[] = locs.map((l, k) => ({ id: `p${k}`, location: l, zone: 'ambient' }));
    const plan = planRoute(new WarehouseGraph(layout), picks, { exposureLimits: [] });
    push('planner_ms', plan.solveMs);
    push('planner_gap', gapPct(plan.distanceMeters!, refBest));
    push('planner_dist', plan.distanceMeters!);
    push('ts_nn_gap', gapPct(ts.nn!, refBest));
    push('ts_s_gap', gapPct(ts.s!, refBest));
    if (ts.nn2 !== undefined) push('ts_nn2_gap', gapPct(ts.nn2, refBest));
    if (ts.exact !== undefined) push('ts_exact_vs_proto_exact', ts.exact - ref.exact_held_karp!);
    push('proto_ortools_ms', ref.ortools_gls_3s_ms!);
    push('proto_ortools_gap', gapPct(ref.ortools_gls_3s!, refBest));
    push(`winner:${plan.algorithm}`, 1);
  }
  unconstrainedRows.push({
    items: n,
    instances: insts.length,
    reference:
      insts[0]!.reference.exact_held_karp !== undefined
        ? 'exact (Held-Karp, prototype)'
        : 'OR-Tools GLS 3 s (prototype)',
    crossValidation: {
      nnIdenticalToPrototype: `${nnMatches}/${insts.length}`,
      sShapeIdentical: `${sMatches}/${insts.length}`,
      twoOptIdentical: twoOptCompared
        ? `${twoOptMatches}/${twoOptCompared}`
        : 'n/a (prototype skipped 2-opt)',
    },
    gapVsReferencePct: {
      ts_nearest_neighbour: r2(mean(acc.ts_nn_gap!)),
      ts_s_shape: r2(mean(acc.ts_s_gap!)),
      ts_nn_2opt: acc.ts_nn2_gap ? r2(mean(acc.ts_nn2_gap)) : null,
      ts_planner_selected: r2(mean(acc.planner_gap!)),
      prototype_ortools_gls_3s: r2(mean(acc.proto_ortools_gap!)),
    },
    exactCheck: acc.ts_exact_vs_proto_exact
      ? { maxAbsDiffMeters: r2(Math.max(...acc.ts_exact_vs_proto_exact.map(Math.abs))) }
      : null,
    plannerWinners: Object.fromEntries(
      Object.entries(acc)
        .filter(([k]) => k.startsWith('winner:'))
        .map(([k, v]) => [k.slice(7), v.length]),
    ),
    runtimeMs: {
      ts_planner_mean: r1(mean(acc.planner_ms!)),
      ts_planner_max: r1(Math.max(...acc.planner_ms!)),
      ts_matrix_cold_mean: r1(mean(acc.matrix_ms!)),
      prototype_ortools_gls_3s_mean: r1(mean(acc.proto_ortools_ms!)),
    },
  });
}

// ---------------- frozen (cold-chain constraint) ----------------
const frozenRows = [];
const fByN = new Map<number, FrozenInstance[]>();
for (const i of data.frozen) fByN.set(i.items, [...(fByN.get(i.items) ?? []), i]);
for (const [n, insts] of fByN) {
  const row = {
    items: n,
    instances: insts.length,
    tsPlanner: {
      feasible: 0,
      distances: [] as number[],
      solveMs: [] as number[],
      winners: {} as Record<string, number>,
    },
    prototype: {} as Record<string, { solved: number; feasible: number; meanDistance: number | null }>,
  };
  const protoKeys = [
    'nearest_neighbour',
    's_shape',
    'ortools_unconstrained_1s',
    'zone_sequenced',
    'ortools_constrained_unseeded_1s',
    'ortools_constrained_seeded_1s',
  ];
  const paired: { ts: number; seeded: number }[] = [];
  for (const inst of insts) {
    const fz = new Set(inst.frozenIndices);
    const picks: PickRequest[] = inst.nodes.slice(1).map(([aisle, pos], k) => ({
      id: `p${k}`,
      location: { aisle, pos },
      zone: fz.has(k + 1) ? 'frozen' : 'ambient',
    }));
    const plan = planRoute(new WarehouseGraph(layout), picks, {
      exposureLimits: [{ zone: 'frozen', maxMeters: data.layout.frozenMaxMeters }],
    });
    if (plan.status === 'feasible') {
      row.tsPlanner.feasible++;
      row.tsPlanner.distances.push(plan.distanceMeters!);
      row.tsPlanner.winners[plan.algorithm!] = (row.tsPlanner.winners[plan.algorithm!] ?? 0) + 1;
      const seeded = inst.reference.ortools_constrained_seeded_1s;
      if (seeded && seeded.violations === 0)
        paired.push({ ts: plan.distanceMeters!, seeded: seeded.distance });
    }
    row.tsPlanner.solveMs.push(plan.solveMs);
  }
  for (const k of protoKeys) {
    const vals = insts.map((i) => i.reference[k]);
    const solved = vals.filter((v): v is FrozenRef => v !== null && v !== undefined);
    const feas = solved.filter((v) => v.violations === 0);
    row.prototype[k] = {
      solved: solved.length,
      feasible: feas.length,
      meanDistance: feas.length ? r1(mean(feas.map((v) => v.distance))) : null,
    };
  }
  frozenRows.push({
    items: n,
    instances: insts.length,
    meanFrozenItems: r1(mean(insts.map((i) => i.frozenIndices.length))),
    tsPlanner: {
      feasible: row.tsPlanner.feasible,
      meanDistance: row.tsPlanner.distances.length ? r1(mean(row.tsPlanner.distances)) : null,
      solveMsMean: r1(mean(row.tsPlanner.solveMs)),
      solveMsMax: r1(Math.max(...row.tsPlanner.solveMs)),
      winners: row.tsPlanner.winners,
    },
    prototype: row.prototype,
    pairedVsSeededOrTools: paired.length
      ? { instances: paired.length, meanGapPct: r2(mean(paired.map((p) => gapPct(p.ts, p.seeded)))) }
      : null,
  });
}

const report = {
  recordedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    platform: `${os.platform()} ${os.release()}`,
  },
  method:
    'Identical instances regenerated by the prototype generator and seeds; prototype references computed by the unmodified prototype functions (OR-Tools 9.15). Gaps are per-instance means vs the reference.',
  unconstrained: unconstrainedRows,
  frozen: frozenRows,
};
writeFileSync('audit/test-results/phase5/route-benchmark.json', JSON.stringify(report, null, 2));

const md: string[] = [
  '# Route planner benchmark (measured)',
  '',
  `Recorded ${report.recordedAt} · ${report.environment.cpu} · Node ${report.environment.node}`,
  '',
  report.method,
  '',
  '## Unconstrained (distance gap vs reference, %; lower is better)',
  '',
  '| Items | Reference | TS NN | TS S-shape | TS NN+2-opt | **TS planner** | Prototype OR-Tools GLS 3 s | TS planner ms (mean / max) | OR-Tools ms | Planner winners | Cross-check NN / S / 2-opt identical |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of unconstrainedRows) {
  const g = r.gapVsReferencePct;
  md.push(
    `| ${r.items} | ${r.reference} | ${g.ts_nearest_neighbour} | ${g.ts_s_shape} | ${g.ts_nn_2opt ?? '—'} | **${g.ts_planner_selected}** | ${g.prototype_ortools_gls_3s} | ${r.runtimeMs.ts_planner_mean} / ${r.runtimeMs.ts_planner_max} | ${r.runtimeMs.prototype_ortools_gls_3s_mean} | ${Object.entries(
      r.plannerWinners,
    )
      .map(([k, v]) => `${k}:${v}`)
      .join(
        ' ',
      )} | ${r.crossValidation.nnIdenticalToPrototype} / ${r.crossValidation.sShapeIdentical} / ${r.crossValidation.twoOptIdentical} |`,
  );
}
md.push(
  '',
  `## Cold-chain constraint (frozen items ≤ ${data.layout.frozenMaxMeters} m walking before exit)`,
  '',
  '| Items | TS planner feasible | TS mean m | TS ms (mean / max) | Proto zone-seq feasible / m | Proto OR-Tools unseeded solved | Proto OR-Tools seeded feasible / m | TS vs seeded OR-Tools (paired gap %) |',
  '|---|---|---|---|---|---|---|---|',
);
for (const f of frozenRows) {
  const p = f.prototype;
  md.push(
    `| ${f.items} | ${f.tsPlanner.feasible}/${f.instances} | ${f.tsPlanner.meanDistance} | ${f.tsPlanner.solveMsMean} / ${f.tsPlanner.solveMsMax} | ${p.zone_sequenced!.feasible} / ${p.zone_sequenced!.meanDistance} | ${p.ortools_constrained_unseeded_1s!.solved}/${f.instances} | ${p.ortools_constrained_seeded_1s!.feasible} / ${p.ortools_constrained_seeded_1s!.meanDistance} | ${f.pairedVsSeededOrTools?.meanGapPct ?? '—'} |`,
  );
}
writeFileSync('audit/test-results/phase5/route-benchmark.md', md.join('\n') + '\n');
console.log(md.join('\n'));
