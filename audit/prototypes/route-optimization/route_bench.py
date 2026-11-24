"""RetailFlow audit prototype: picking-route optimisation benchmark.

Warehouse = graph. 20 parallel aisles, 50 m long, 3 m apart, cross-aisles at the
front (y=0), middle (y=25) and back (y=50) -> a 2-block layout. Depot (entry/exit)
at front of aisle 0. Pick locations are integer metres along an aisle.

Compares: nearest-neighbour, S-shape, NN+2-opt, OR-Tools (first solution and
guided local search), and exact Held-Karp DP for small orders.
Temperature constraint: frozen items (in aisles 0-1, a freezer zone near the dock)
must be picked no more than FROZEN_MAX_M metres of walking before the exit.
All numbers printed are measured on this machine.
"""
import heapq, itertools, json, math, platform, random, statistics, sys, time

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

AISLES, LENGTH, SPACING = 20, 50, 3
CROSS = (0, 25, 50)
WALK_MPS, PICK_SEC = 1.2, 10
FROZEN_MAX_M = 40
SCALE = 10  # OR-Tools needs integers: decimetres


def build_graph():
    adj = {}
    def add(u, v, w):
        adj.setdefault(u, []).append((v, w)); adj.setdefault(v, []).append((u, w))
    for a in range(AISLES):
        for y in range(LENGTH):
            add((a, y), (a, y + 1), 1.0)
    for a in range(AISLES - 1):
        for y in CROSS:
            add((a, y), (a + 1, y), SPACING)
    return adj


def dijkstra(adj, src):
    dist = {src: 0.0}; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd; heapq.heappush(pq, (nd, v))
    return dist


def matrix(adj, nodes):
    D = []
    for u in nodes:
        d = dijkstra(adj, u); D.append([d[v] for v in nodes])
    return D


def route_len(D, r):
    return sum(D[r[i]][r[i + 1]] for i in range(len(r) - 1))


def nearest_neighbour(D):
    n = len(D); left = set(range(1, n)); r = [0]
    while left:
        nxt = min(left, key=lambda j: D[r[-1]][j]); r.append(nxt); left.remove(nxt)
    return r + [0]


def two_opt(D, r):
    best = r[:]; improved = True
    while improved:
        improved = False
        for i in range(1, len(best) - 2):
            for j in range(i + 1, len(best) - 1):
                a, b, c, d = best[i - 1], best[i], best[j], best[j + 1]
                if D[a][c] + D[b][d] < D[a][b] + D[c][d] - 1e-9:
                    best[i:j + 1] = reversed(best[i:j + 1]); improved = True
    return best


def s_shape(nodes):
    """Classic S-shape: visit aisles with picks left to right, traverse each fully,
    alternating direction. Implemented per block-agnostic (full aisle traversal)."""
    idx = {n: i for i, n in enumerate(nodes)}
    aisles = sorted({a for a, _ in nodes[1:]})
    r = [0]
    for k, a in enumerate(aisles):
        picks = sorted([n for n in nodes[1:] if n[0] == a], key=lambda n: n[1], reverse=(k % 2 == 1))
        r += [idx[p] for p in picks]
    return r + [0]


def held_karp(D):
    n = len(D)
    if n <= 2:
        return route_len(D, [0, 1, 0] if n == 2 else [0, 0])
    C = {}
    for k in range(1, n):
        C[(1 << k, k)] = D[0][k]
    for size in range(2, n):
        for subset in itertools.combinations(range(1, n), size):
            bits = sum(1 << b for b in subset)
            for k in subset:
                prev = bits & ~(1 << k)
                C[(bits, k)] = min(C[(prev, m)] + D[m][k] for m in subset if m != k)
    full = (1 << n) - 2
    return min(C[(full, k)] + D[k][0] for k in range(1, n))


def ortools_route(D, time_limit=None, frozen=(), frozen_max=None):
    n = len(D)
    mgr = pywrapcp.RoutingIndexManager(n, 1, 0)
    rt = pywrapcp.RoutingModel(mgr)
    Di = [[int(round(x * SCALE)) for x in row] for row in D]
    cb = rt.RegisterTransitCallback(lambda i, j: Di[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
    rt.SetArcCostEvaluatorOfAllVehicles(cb)
    if frozen and frozen_max is not None:
        rt.AddDimension(cb, 0, 10 ** 9, True, 'dist')
        dim = rt.GetDimensionOrDie('dist')
        end = dim.CumulVar(rt.End(0)); s = rt.solver()
        for f in frozen:
            s.Add(end - dim.CumulVar(mgr.NodeToIndex(f)) <= int(frozen_max * SCALE))
    p = pywrapcp.DefaultRoutingSearchParameters()
    p.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    if time_limit:
        p.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        p.time_limit.FromMilliseconds(int(time_limit * 1000))
    sol = rt.SolveWithParameters(p)
    if not sol:
        return None
    i = rt.Start(0); r = []
    while not rt.IsEnd(i):
        r.append(mgr.IndexToNode(i)); i = sol.Value(rt.NextVar(i))
    return r + [0]


def frozen_violations(D, r, frozen):
    total = route_len(D, r); acc = 0.0; v = 0
    for i in range(len(r) - 1):
        if r[i] in frozen and total - acc > FROZEN_MAX_M + 1e-9:
            v += 1
        acc += D[r[i]][r[i + 1]]
    return v


def timed(fn, *a, **k):
    t = time.perf_counter(); out = fn(*a, **k); return out, (time.perf_counter() - t) * 1000


def order(rng, n, frozen_share):
    slots = set()
    while len(slots) < n:
        if rng.random() < frozen_share:
            slots.add((rng.randint(0, 1), rng.randint(1, 10)))   # freezer zone near dock
        else:
            slots.add((rng.randint(2, AISLES - 1), rng.randint(1, LENGTH - 1)))
    return sorted(slots)


def main():
    adj = build_graph()
    out = {'env': {'python': sys.version.split()[0], 'platform': platform.platform(), 'cpu': platform.processor(),
                   'layout': f'{AISLES} aisles x {LENGTH} m, spacing {SPACING} m, cross-aisles {CROSS}',
                   'walk_mps': WALK_MPS, 'pick_sec': PICK_SEC, 'frozen_max_m': FROZEN_MAX_M}, 'unconstrained': [], 'frozen': []}
    seeds = 5
    for n in [8, 12, 25, 50, 100, 200, 400]:
        agg = {}
        for s in range(seeds):
            rng = random.Random(1000 * n + s)
            nodes = [(0, 0)] + order(rng, n, 0.0)
            D, tm = timed(matrix, adj, nodes)
            res = {'matrix_ms': (None, tm)}
            r, t = timed(nearest_neighbour, D); res['nearest_neighbour'] = (route_len(D, r), t)
            r, t = timed(s_shape, nodes); res['s_shape'] = (route_len(D, r), t)
            nn = nearest_neighbour(D)
            if n <= 200:
                r, t = timed(two_opt, D, nn); res['nn_2opt'] = (route_len(D, r), t)
            r, t = timed(ortools_route, D); res['ortools_first_solution'] = (route_len(D, r), t)
            for tl in (1.0, 3.0):
                r, t = timed(ortools_route, D, tl); res[f'ortools_gls_{tl:g}s'] = (route_len(D, r), t)
            if n <= 12:
                v, t = timed(held_karp, D); res['exact_held_karp'] = (v, t)
            for k, v in res.items():
                agg.setdefault(k, []).append(v)
        best_ref = 'exact_held_karp' if n <= 12 else 'ortools_gls_3s'
        refs = [x[0] for x in agg[best_ref]]
        row = {'items': n, 'seeds': seeds, 'reference_for_gap': best_ref}
        for k, vals in agg.items():
            if k == 'matrix_ms':
                row[k] = round(statistics.mean(v[1] for v in vals), 1); continue
            d = statistics.mean(v[0] for v in vals)
            gap = statistics.mean((v[0] / refs[i] - 1) * 100 for i, v in enumerate(vals))
            row[k] = {'distance_m': round(d, 1), 'gap_vs_ref_pct': round(gap, 2),
                      'est_minutes': round((d / WALK_MPS + n * PICK_SEC) / 60, 1),
                      'runtime_ms_mean': round(statistics.mean(v[1] for v in vals), 1),
                      'runtime_ms_max': round(max(v[1] for v in vals), 1)}
        out['unconstrained'].append(row); print(json.dumps(row)); sys.stdout.flush()

    # Temperature-constrained runs
    for n in [25, 50, 100]:
        rows = []
        for s in range(seeds):
            rng = random.Random(7 + 31 * n + s)
            nodes = [(0, 0)] + order(rng, n, 0.15)
            frozen = {i for i, nd in enumerate(nodes) if i and nd[0] <= 1}
            D = matrix(adj, nodes)
            nn = nearest_neighbour(D); ss = s_shape(nodes)
            unc = ortools_route(D, 1.0)
            con, t = timed(ortools_route, D, 1.0, frozen, FROZEN_MAX_M)
            rows.append({'frozen_items': len(frozen),
                         'nn': (route_len(D, nn), frozen_violations(D, nn, frozen)),
                         's_shape': (route_len(D, ss), frozen_violations(D, ss, frozen)),
                         'ortools_unconstrained': (route_len(D, unc), frozen_violations(D, unc, frozen)),
                         'ortools_constrained': None if con is None else (route_len(D, con), frozen_violations(D, con, frozen), t)})
        summ = {'items': n, 'seeds': seeds, 'mean_frozen_items': statistics.mean(r['frozen_items'] for r in rows)}
        for k in ('nn', 's_shape', 'ortools_unconstrained'):
            summ[k] = {'distance_m': round(statistics.mean(r[k][0] for r in rows), 1),
                       'routes_with_violation': sum(1 for r in rows if r[k][1] > 0),
                       'total_violating_items': sum(r[k][1] for r in rows)}
        feas = [r['ortools_constrained'] for r in rows if r['ortools_constrained']]
        summ['ortools_constrained'] = {'solved': len(feas), 'distance_m': round(statistics.mean(f[0] for f in feas), 1) if feas else None,
                                       'total_violating_items': sum(f[1] for f in feas)}
        out['frozen'].append(summ); print(json.dumps(summ)); sys.stdout.flush()

    with open('route_results.json', 'w') as f:
        json.dump(out, f, indent=2)


if __name__ == '__main__':
    main()
