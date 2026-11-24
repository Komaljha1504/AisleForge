# OR-Tools seeded with the TypeScript planner route (measured)

Recorded 2026-11-21T16:18:28Z · OR-Tools 9.15.6755 · Python 3.12.10

OR-Tools (prototype model code, Python transit callback, PATH_CHEAPEST_ARC params, guided local search) seeded with the TypeScript planner route via ReadAssignmentFromRoutes; same instances and limits as the prototype: 3 s unconstrained, 1 s frozen (<= 40 m). Improvement = (TS distance / seeded distance - 1).

**For instances above 12 picks no solver here proves optimality: neither the TS route nor the seeded OR-Tools route is known to be globally optimal; gaps are relative, not to the optimum. Time-limited guided local search is not deterministic between runs.**

Separate from route-benchmark.md (unchanged). Python recomputation of every TS route: distances identical to the TS planner, 0 frozen-rule violations.

## Unconstrained (GLS 3 s)

| Items | Seeded solved | TS mean m | Seeded OR-Tools mean m | Mean improvement over TS % | Instances improved | Worse than seed | Seeded vs unseeded OR-Tools % | Seeded ms |
|---|---|---|---|---|---|---|---|---|
| 8 | 5/5 | 256.8 | 256.8 | 0 | 0 | 0 | 0 | 3023 |
| 12 | 5/5 | 279.6 | 279.6 | 0 | 0 | 0 | 0 | 3006.1 |
| 25 | 5/5 | 426.4 | 425.2 | 0.27 | 2 | 0 | 0 | 3007.6 |
| 50 | 5/5 | 634.4 | 627.2 | 1.12 | 5 | 0 | -0.53 | 3009.8 |
| 100 | 5/5 | 870.8 | 868.8 | 0.23 | 2 | 0 | -0.59 | 3015.3 |
| 200 | 5/5 | 1006 | 1005.2 | 0.08 | 1 | 0 | -1.87 | 3047.4 |
| 400 | 5/5 | 1014 | 1014 | 0 | 0 | 0 | -3.14 | 3140.6 |

For 8 and 12 picks both routes equal the Held-Karp optimum (proven). Above 12 picks no route here is proven optimal.

## Frozen items ≤ 40 m before exit (GLS 1 s, constraint enforced)

| Items | Seeded solved | Seeded feasible | TS mean m | Seeded OR-Tools mean m | Mean improvement over TS % | Instances improved | Worse than seed | Seeded ms |
|---|---|---|---|---|---|---|---|---|
| 25 | 5/5 | 5/5 | 440 | 430.4 | 2.17 | 3 | 0 | 1008.4 |
| 50 | 5/5 | 5/5 | 591.6 | 591.2 | 0.07 | 1 | 0 | 1012.3 |
| 100 | 5/5 | 5/5 | 888.4 | 888 | 0.04 | 1 | 0 | 1017.8 |
