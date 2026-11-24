"""Review item 2: OR-Tools seeded with a FEASIBLE initial route (the TypeScript planner's route), on the same
instances, constraints and time limits as the audit prototype:
  - unconstrained: guided local search, 3 s (prototype's reference budget);
  - frozen (each frozen item <= 40 m walking before the exit): guided local search, 1 s (prototype's budget).
Uses the prototype's own, unmodified model code (route_followup.solve, which seeds via ReadAssignmentFromRoutes +
SolveFromAssignmentWithParameters, and route_bench helpers). Writes a SEPARATE result file:
  audit/test-results/phase5/ortools-seeded-comparison.json
Existing route-benchmark.* results are not modified.
"""
import ast, json, os, platform, statistics, sys, time, types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PROTO = os.path.join(ROOT, 'audit', 'prototypes', 'route-optimization')
sys.dont_write_bytecode = True  # never leave __pycache__ inside the audit evidence folder
sys.path.insert(0, PROTO)
import route_bench as rb  # noqa: E402

_tree = ast.parse(open(os.path.join(PROTO, 'route_followup.py'), encoding='utf-8').read())
_tree.body = [n for n in _tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))]
rf = types.ModuleType('route_followup_defs')
exec(compile(_tree, 'route_followup.py', 'exec'), rf.__dict__)

P5 = os.path.join(ROOT, 'audit', 'test-results', 'phase5')
inst = json.load(open(os.path.join(P5, 'prototype-instances.json')))
ts = json.load(open(os.path.join(P5, 'ts-planner-routes.json')))
adj = rb.build_graph()
FROZEN_MAX = inst['layout']['frozenMaxMeters']


def run(section, time_limit):
    rows = []
    for p, t in zip(inst[section], ts[section]):
        assert p['seed'] == t['seed'] and p['items'] == t['items'], 'instance mismatch'
        nodes = [tuple(x) for x in p['nodes']]
        D = rb.matrix(adj, nodes)
        frozen = set(p.get('frozenIndices', []))
        row = {'items': p['items'], 'seed': p['seed'], 'tsAlgorithm': t['algorithm'], 'tsDistance': None,
               'tsViolations': None, 'seededDistance': None, 'seededViolations': None, 'seededMs': None, 'solved': False}
        if t['route'] is None:
            row['note'] = 'TS planner returned infeasible; no seed available'
            rows.append(row); continue
        seed = t['route']
        row['tsDistance'] = rb.route_len(D, seed)  # recomputed in Python from the same matrix
        row['tsViolations'] = rb.frozen_violations(D, seed, frozen) if frozen else 0
        t0 = time.perf_counter()
        r, _ = rf.solve(D, frozen, initial=seed, tl=time_limit)
        row['seededMs'] = (time.perf_counter() - t0) * 1000
        if r is not None:
            row['solved'] = True
            row['seededDistance'] = rb.route_len(D, r)
            row['seededViolations'] = rb.frozen_violations(D, r, frozen) if frozen else 0
        prev = p['reference']
        if section == 'unconstrained':
            row['unseededOrTools3s'] = prev['ortools_gls_3s']
            row['exact'] = prev.get('exact_held_karp')
        else:
            u = prev.get('ortools_constrained_unseeded_1s'); s = prev.get('ortools_constrained_seeded_1s')
            row['unseededOrTools1s'] = None if u is None else u['distance']
            row['zoneSeqSeededOrTools1s'] = None if s is None else s['distance']
        rows.append(row)
        print(section, p['items'], p['seed'], row['tsDistance'], '->', row['seededDistance'], flush=True)
    return rows


def pct(a, b):
    return (a / b - 1) * 100


def summarize(rows, section):
    out = []
    for n in sorted({r['items'] for r in rows}):
        rs = [r for r in rows if r['items'] == n and r['solved']]
        s = {'items': n, 'instances': len([r for r in rows if r['items'] == n]), 'seededSolved': len(rs),
             'seededFeasible': sum(1 for r in rs if r['seededViolations'] == 0),
             'meanTsDistance': round(statistics.mean(r['tsDistance'] for r in rs), 1) if rs else None,
             'meanSeededDistance': round(statistics.mean(r['seededDistance'] for r in rs), 1) if rs else None,
             'meanImprovementOverTsPct': round(statistics.mean(pct(r['tsDistance'], r['seededDistance']) for r in rs), 2) if rs else None,
             'instancesImproved': sum(1 for r in rs if r['seededDistance'] < r['tsDistance'] - 1e-9),
             'instancesWorseThanSeed': sum(1 for r in rs if r['seededDistance'] > r['tsDistance'] + 1e-9),
             'meanSeededMs': round(statistics.mean(r['seededMs'] for r in rs), 1) if rs else None}
        key = 'unseededOrTools3s' if section == 'unconstrained' else 'unseededOrTools1s'
        un = [r for r in rs if r.get(key) is not None]
        if un:
            s['seededVsUnseededPct'] = round(statistics.mean(pct(r['seededDistance'], r[key]) for r in un), 2)
        ex = [r for r in rs if r.get('exact') is not None]
        if ex:
            s['seededVsExactPct'] = round(statistics.mean(pct(r['seededDistance'], r['exact']) for r in ex), 2)
            s['tsVsExactPct'] = round(statistics.mean(pct(r['tsDistance'], r['exact']) for r in ex), 2)
        out.append(s)
    return out


unc = run('unconstrained', 3.0)
frz = run('frozen', 1.0)
result = {
    'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'environment': {'python': sys.version.split()[0], 'platform': platform.platform(), 'ortools': __import__('ortools').__version__},
    'method': ('OR-Tools (prototype model code, Python transit callback, PATH_CHEAPEST_ARC params, guided local search) '
               'seeded with the TypeScript planner route via ReadAssignmentFromRoutes; same instances and limits as the '
               'prototype: 3 s unconstrained, 1 s frozen (<= %s m). Improvement = (TS distance / seeded distance - 1).' % FROZEN_MAX),
    'interpretationLimits': ('For instances above 12 picks no solver here proves optimality: neither the TS route nor the '
                             'seeded OR-Tools route is known to be globally optimal; gaps are relative, not to the optimum. '
                             'Time-limited guided local search is not deterministic between runs.'),
    'summary': {'unconstrained': summarize(unc, 'unconstrained'), 'frozen': summarize(frz, 'frozen')},
    'instances': {'unconstrained': unc, 'frozen': frz},
}
with open(os.path.join(P5, 'ortools-seeded-comparison.json'), 'w') as f:
    json.dump(result, f, indent=2)
print(json.dumps(result['summary'], indent=2))
