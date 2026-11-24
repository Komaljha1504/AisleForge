"""Export the audit prototype's route-benchmark instances, with per-instance reference results computed by the
prototype's own (unmodified) functions, so the TypeScript planner can be compared on IDENTICAL inputs.

Reads (never modifies) audit/prototypes/route-optimization/route_bench.py and route_followup.py.
Writes audit/test-results/phase5/prototype-instances.json.

Run with the prototype's environment (OR-Tools 9.15):
    <venv-with-ortools>/python tools/route-benchmark/export_prototype_instances.py
"""
import ast, json, os, random, sys, time, types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PROTO = os.path.join(ROOT, 'audit', 'prototypes', 'route-optimization')
sys.path.insert(0, PROTO)
import route_bench as rb  # noqa: E402  (has a __main__ guard: importing does not run its benchmark)

# route_followup.py runs its experiment at module level (no __main__ guard) and writes a results file. Load ONLY its
# imports and function definitions, so the prototype code is reused verbatim without side effects.
_src = open(os.path.join(PROTO, 'route_followup.py'), encoding='utf-8').read()
_tree = ast.parse(_src)
_tree.body = [n for n in _tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))]
rf = types.ModuleType('route_followup_defs')
exec(compile(_tree, 'route_followup.py', 'exec'), rf.__dict__)

out = {
    'generatedBy': 'tools/route-benchmark/export_prototype_instances.py',
    'layout': {'aisles': rb.AISLES, 'aisleLength': rb.LENGTH, 'aisleSpacing': rb.SPACING, 'crossAisles': list(rb.CROSS),
               'depot': [0, 0], 'walkSpeedMps': rb.WALK_MPS, 'pickSeconds': rb.PICK_SEC, 'frozenMaxMeters': rb.FROZEN_MAX_M},
    'unconstrained': [], 'frozen': [],
}
adj = rb.build_graph()

for n in [8, 12, 25, 50, 100, 200, 400]:
    for s in range(5):
        rng = random.Random(1000 * n + s)
        nodes = [(0, 0)] + rb.order(rng, n, 0.0)
        D = rb.matrix(adj, nodes)
        ref = {'nearest_neighbour': rb.route_len(D, rb.nearest_neighbour(D)),
               's_shape': rb.route_len(D, rb.s_shape(nodes))}
        if n <= 200:
            ref['nn_2opt'] = rb.route_len(D, rb.two_opt(D, rb.nearest_neighbour(D)))
        t = time.perf_counter(); r = rb.ortools_route(D, 3.0)
        ref['ortools_gls_3s'] = rb.route_len(D, r); ref['ortools_gls_3s_ms'] = (time.perf_counter() - t) * 1000
        if n <= 12:
            ref['exact_held_karp'] = rb.held_karp(D)
        inst = {'items': n, 'seed': 1000 * n + s, 'nodes': nodes, 'reference': ref}
        if n <= 50:
            inst['matrix'] = D  # for cross-implementation validation of shortest paths
        out['unconstrained'].append(inst)
        print('unconstrained', n, s, {k: round(v, 1) for k, v in ref.items()}, flush=True)

for n in [25, 50, 100]:
    for s in range(5):
        rng = random.Random(7 + 31 * n + s)
        nodes = [(0, 0)] + rb.order(rng, n, 0.15)
        frozen = sorted(i for i, nd in enumerate(nodes) if i and nd[0] <= 1)
        D = rb.matrix(adj, nodes)
        fz = set(frozen)
        ref = {}
        for name, route in [('nearest_neighbour', rb.nearest_neighbour(D)), ('s_shape', rb.s_shape(nodes)),
                            ('ortools_unconstrained_1s', rb.ortools_route(D, 1.0))]:
            ref[name] = {'distance': rb.route_len(D, route), 'violations': rb.frozen_violations(D, route, fz)}
        z = rf.zone_sequenced(D, fz)
        ref['zone_sequenced'] = {'distance': rb.route_len(D, z), 'violations': rb.frozen_violations(D, z, fz)}
        unseeded, _ = rf.solve(D, fz)
        ref['ortools_constrained_unseeded_1s'] = None if unseeded is None else {'distance': rb.route_len(D, unseeded), 'violations': rb.frozen_violations(D, unseeded, fz)}
        seeded, _ = rf.solve(D, fz, initial=z)
        ref['ortools_constrained_seeded_1s'] = None if seeded is None else {'distance': rb.route_len(D, seeded), 'violations': rb.frozen_violations(D, seeded, fz)}
        out['frozen'].append({'items': n, 'seed': 7 + 31 * n + s, 'nodes': nodes, 'frozenIndices': frozen, 'reference': ref})
        print('frozen', n, s, len(frozen), flush=True)

dest = os.path.join(ROOT, 'audit', 'test-results', 'phase5')
os.makedirs(dest, exist_ok=True)
with open(os.path.join(dest, 'prototype-instances.json'), 'w') as f:
    json.dump(out, f)
print('wrote', os.path.join(dest, 'prototype-instances.json'))
