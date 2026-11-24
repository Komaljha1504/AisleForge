"""Follow-up: (1) is the frozen constraint infeasible, or did OR-Tools just fail to find
a first solution? (2) cost of a Python transit callback vs RegisterTransitMatrix."""
import json, random, statistics, time
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from route_bench import (build_graph, matrix, order, nearest_neighbour, two_opt, route_len,
                         frozen_violations, FROZEN_MAX_M, SCALE)


def zone_sequenced(D, frozen):
    """Ambient items first (NN+2opt, depot -> ambient), then frozen items last, then exit."""
    amb = [i for i in range(1, len(D)) if i not in frozen]
    fz = [i for i in range(1, len(D)) if i in frozen]
    r = [0]; left = set(amb)
    while left:
        nxt = min(left, key=lambda j: D[r[-1]][j]); r.append(nxt); left.remove(nxt)
    # frozen block: order so that the LAST stretch to exit is short -> build NN backwards from depot
    back = [0]; left = set(fz)
    while left:
        nxt = min(left, key=lambda j: D[back[-1]][j]); back.append(nxt); left.remove(nxt)
    r += list(reversed(back[1:])) + [0]
    # 2-opt restricted inside the ambient segment only, keeps frozen block intact
    k = len(amb) + 1
    seg = two_opt(D, r[:k] + [r[k] if k < len(r) else 0])
    return seg[:-1] + r[k:]


def solve(D, frozen, initial=None, strategy=None, tl=1.0, use_matrix=False):
    n = len(D); mgr = pywrapcp.RoutingIndexManager(n, 1, 0); rt = pywrapcp.RoutingModel(mgr)
    Di = [[int(round(x * SCALE)) for x in row] for row in D]
    cb = rt.RegisterTransitMatrix(Di) if use_matrix else rt.RegisterTransitCallback(
        lambda i, j: Di[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
    rt.SetArcCostEvaluatorOfAllVehicles(cb)
    if frozen:
        rt.AddDimension(cb, 0, 10 ** 9, True, 'dist'); dim = rt.GetDimensionOrDie('dist')
        end = dim.CumulVar(rt.End(0))
        for f in frozen:
            rt.solver().Add(end - dim.CumulVar(mgr.NodeToIndex(f)) <= int(FROZEN_MAX_M * SCALE))
    p = pywrapcp.DefaultRoutingSearchParameters()
    p.first_solution_strategy = strategy or routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    if tl:
        p.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        p.time_limit.FromMilliseconds(int(tl * 1000))
    t = time.perf_counter()
    if initial:
        rt.CloseModelWithParameters(p)
        a = rt.ReadAssignmentFromRoutes([initial[1:-1]], True)
        sol = rt.SolveFromAssignmentWithParameters(a, p) if a else None
    else:
        sol = rt.SolveWithParameters(p)
    ms = (time.perf_counter() - t) * 1000
    if not sol:
        return None, ms
    i = rt.Start(0); r = []
    while not rt.IsEnd(i):
        r.append(mgr.IndexToNode(i)); i = sol.Value(rt.NextVar(i))
    return r + [0], ms


adj = build_graph(); out = {'frozen_followup': [], 'callback_vs_matrix': []}
for n in [25, 50, 100]:
    agg = {'zone_seq': [], 'ort_cheapest_arc': [], 'ort_local_cheapest_insertion': [], 'ort_seeded_with_zone_seq': []}
    for s in range(5):
        rng = random.Random(7 + 31 * n + s)   # same instances as route_bench.py
        nodes = [(0, 0)] + order(rng, n, 0.15)
        frozen = {i for i, nd in enumerate(nodes) if i and nd[0] <= 1}
        D = matrix(adj, nodes)
        z = zone_sequenced(D, frozen)
        agg['zone_seq'].append((route_len(D, z), frozen_violations(D, z, frozen), 0))
        for key, kw in [('ort_cheapest_arc', {}),
                        ('ort_local_cheapest_insertion', {'strategy': routing_enums_pb2.FirstSolutionStrategy.LOCAL_CHEAPEST_INSERTION}),
                        ('ort_seeded_with_zone_seq', {'initial': z})]:
            r, ms = solve(D, frozen, **kw)
            agg[key].append(None if r is None else (route_len(D, r), frozen_violations(D, r, frozen), ms))
    row = {'items': n}
    for k, v in agg.items():
        ok = [x for x in v if x]
        row[k] = {'solved': len(ok), 'feasible_routes': sum(1 for x in ok if x[1] == 0),
                  'mean_distance_m': round(statistics.mean(x[0] for x in ok), 1) if ok else None}
    out['frozen_followup'].append(row); print(json.dumps(row), flush=True)

for n in [100, 200, 400]:
    rng = random.Random(1000 * n); nodes = [(0, 0)] + order(rng, n, 0.0); D = matrix(adj, nodes)
    _, cb_ms = solve(D, set(), tl=None, use_matrix=False)
    _, mx_ms = solve(D, set(), tl=None, use_matrix=True)
    row = {'items': n, 'default_solve_python_callback_ms': round(cb_ms, 1), 'default_solve_transit_matrix_ms': round(mx_ms, 1)}
    out['callback_vs_matrix'].append(row); print(json.dumps(row), flush=True)

json.dump(out, open('route_followup_results.json', 'w'), indent=2)
