# ADR-006 — Algorithmic pick-route planning in TypeScript (no ML, OR-Tools deferred)

**Status:** Phase 5 planner implemented, tested and benchmarked. Integration into pick-task creation is
**blocked on Phase 2** (tasks are created by a Kafka consumer).
Evidence: `audit/test-results/phase5/route-benchmark.{json,md}`.

## Decision

`packages/routing` plans a single picker's route in-process, with no extra service or runtime:

- **Graph:** one node per (aisle, metre), cross-aisle edges, Dijkstra with a binary heap, and per-source distance
  caching per layout version. It reproduces the Python prototype's distance matrices exactly (cross-implementation test).
- **Candidates:** S-shape (always computed first; deterministic fallback), nearest-neighbour + 2-opt, exact Held–Karp
  (≤ 12 picks), a cold-chain-aware zone-sequenced construction, and a final **2-opt + Or-opt local search** on the
  best feasible candidate. Every step runs inside a time budget (default 250 ms).
- **Constraints:** the operating rule is modelled directly: maximum _time_ (and/or distance) from picking a chilled or
  frozen item to reaching the hand-off/exit. There is no hard-coded ambient → chilled → frozen sequence. Default policy
  (configurable): chilled ≤ 20 min, frozen ≤ 10 min.
- **Safety:** the shortest **feasible** candidate wins. If none is feasible, the plan is `infeasible` with **no stops**
  plus the violations, so an invalid route can never be used by mistake. On optimizer failure the planner returns the
  S-shape route with `fallbackUsed: true`. Inputs are capped (≤ 500 picks, unique ids, locations inside the layout).

## Measured — comparison 1: planner vs unseeded OR-Tools (identical prototype instances, this laptop)

Source: `audit/test-results/phase5/route-benchmark.{json,md}` (unchanged).

| Items                    | Planner vs OR-Tools GLS 3 s (prototype, unseeded)                                                | Planner solve time | OR-Tools time   |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------ | --------------- |
| 8, 12                    | 0 % — equal to the Held–Karp optimum (proven by exact DP)                                        | ~5–6 ms            | ~3 000 ms       |
| 25, 50                   | +0.27 %, +0.58 %                                                                                 | 5–9 ms             | ~3 000 ms       |
| 100, 200, 400            | −0.36 %, −1.79 %, −3.14 %                                                                        | 17–48 ms           | ~3 000–3 200 ms |
| Frozen ≤ 40 m, 25/50/100 | 15/15 feasible (unseeded OR-Tools: 1/15); +2.2 / +0.8 / +0.04 % vs zone-sequence-seeded OR-Tools | 4–14 ms            | 1 000 ms        |

## Measured — comparison 2: OR-Tools seeded with the planner's own route (review item 2)

Source: `audit/test-results/phase5/ortools-seeded-comparison.{json,md}`. Same instances, same constraint, same time
limits (3 s unconstrained, 1 s frozen) and the prototype's own model code. OR-Tools starts from the TypeScript route
via `ReadAssignmentFromRoutes`. A Python recomputation confirmed every TypeScript route's distance and 0 rule violations.

| Items                      | Mean improvement OR-Tools found over the planner route | Instances improved | Seeded vs unseeded OR-Tools |
| -------------------------- | ------------------------------------------------------ | ------------------ | --------------------------- |
| 8, 12                      | 0 % (both at the proven optimum)                       | 0 / 10             | 0 %                         |
| 25                         | 0.27 %                                                 | 2 / 5              | 0 %                         |
| 50                         | 1.12 %                                                 | 5 / 5              | −0.53 %                     |
| 100                        | 0.23 %                                                 | 2 / 5              | −0.59 %                     |
| 200                        | 0.08 %                                                 | 1 / 5              | −1.87 %                     |
| 400                        | 0 %                                                    | 0 / 5              | −3.14 %                     |
| Frozen 25 / 50 / 100 (1 s) | 2.17 % / 0.07 % / 0.04 %, all 15 feasible              | 5 / 15             | —                           |

**Interpretation, stated carefully.**

- **The planner's routes are not optimal above 12 picks.** OR-Tools seeded with them found routes up to ~1 %
  (unconstrained) and ~2 % (cold-chain, 25 picks) shorter within 1–3 s.
- **Nothing here proves optimality above 12 picks, for either solver.** All gaps above 12 picks are relative to a
  reference, not to the global optimum. Only the 8- and 12-pick results are proven optimal (exact DP).
- The negative "seeded vs unseeded" numbers show OR-Tools itself does better from a good start than from its own
  cheapest-arc start at these budgets. That is a statement about OR-Tools, not about global optimality.
- OR-Tools would improve further with longer budgets. Time-limited guided local search is not deterministic between runs.

## Consequence for OR-Tools (unchanged by comparison 2; review item 4)

The planner gets within about 0–1 % (unconstrained) and 0–2 % (cold-chain) of what seeded OR-Tools reaches in 1–3 s,
at about 1/100th of the latency, in-process and with no second runtime. At the stated walking speed, 1 % of a 600 m
route is about 5 s. A Python/FastAPI OR-Tools service is **not** introduced for single-route optimization. The
TypeScript implementation and its benchmark results stay as they are. OR-Tools stays deferred to multi-order batching
(tote/cart capacity, multi-picker assignment, time windows), where it must beat a measured baseline before it is adopted.

## Integration into the order workflow (Phase 2, 2026-11-22)

The `order-workflow` Kafka consumer plans a route for every `order.placed` event (`planTaskForOrder` in
`packages/domain/src/picking/pickTasks.ts`) and stores it on the pick task. Inputs come from PostgreSQL:
`store_layouts` (the graph, plus optional `exposureLimits`), `sku_locations` (bins) and `products.temperature_zone`.

| `route_status` | When                                                           | Stops                                            |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `feasible`     | the planner found a route that satisfies the cold-chain policy | ordered stops; lines without a bin in `unrouted` |
| `fallback`     | the optimizer failed and S-shape was used (runbook E11)        | S-shape order                                    |
| `infeasible`   | no candidate satisfies the cold-chain policy                   | **none**, with a reason for the supervisor       |
| `unplanned`    | no layout, no bin locations, or a planning error               | none; lines listed unordered                     |

Routing never blocks task creation, and all four outcomes are exercised end to end in `tests/kafka/k2-order-workflow.test.ts`.

**Tie-break (observed in K2).** For the small orders in K2 (2–3 picks on a 6-aisle grid), all 30 routes reported
`s_shape`. With so few picks the candidates often have equal length, and the planner keeps the first candidate
evaluated among equals, which is S-shape. That is the shortest feasible route, not a fallback; a real fallback is
reported as `route_status = 'fallback'`.
