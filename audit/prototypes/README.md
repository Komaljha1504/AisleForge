# Audit prototypes

These are small, isolated experiments that test the audit's most important assumptions.
They are **not** RetailFlow application code. Every number in `audit/RETAILFLOW_AUDIT.md` tagged
`[MEASURED]` comes from these scripts. The raw output is in each `results/` folder.

## Test environment (measured)

- Laptop: Intel i5-1135G7 (4 cores / 8 threads), 7.7 GB RAM, Windows 11
- PostgreSQL 18.7, Windows x64 build, run through the `embedded-postgres` npm package. No Docker. `fsync` is on.
- Node v24.11.1 with `pg` 8.x. Python 3.12.10 with OR-Tools 9.15.
- The load generator and the database share the same 4-core machine. On Windows, Postgres starts a new
  OS process for every connection. **Treat the numbers as relative comparisons, not capacity figures.**
  A Linux host with a separate load generator will produce different absolute numbers.

## inventory-concurrency/

```
cd audit/prototypes/inventory-concurrency
npm install                      # installs embedded-postgres (~100 MB binaries) + pg
node bench.mjs                   # all tests (~6 min)
node bench.mjs T1,T5             # subset
```

Environment variables: `PGPORT_AUDIT` (default 54329), `PGDATA_DIR` (default `./pgdata`), `OUT` (results file).

| Test | Question |
|---|---|
| T1 | Do read-then-write, SERIALIZABLE and conditional-UPDATE reservation oversell under a last-unit race? |
| T2 | Do 100 concurrent retries of one request create one reservation? |
| T3 | Throughput and p50/p95/p99 vs concurrency (10/50/200/500) and key skew (uniform / 1%-hot / single SKU) |
| T4 | Do multi-line orders deadlock with arbitrary vs sorted lock order? |
| T5 | What happens when replicas × pool size > `max_connections`? |
| T6 | Does `WHERE id > last_published_id` outbox polling lose events? |
| T7 | Does a reservation-expiry job racing a pick-confirm corrupt stock? |

**Run notes. Read these before quoting numbers:**
- `results/run1-*` T1 is **invalid** and is kept only for transparency. The naive strategy ran first
  on a cold pool, and slow Windows connection setup spread the requests out so the race never happened.
  `results/run2-*` reruns T1 with a warm pool. Those are the valid T1 figures.
- `results/run1-*` T5 used a 3 s connect timeout, so it measured how slowly Windows sets up connections,
  not `max_connections`. `run2` used a 30 s timeout. Those are the valid T5 figures.
- The run1 T4 "arbitrary lock order" case was stopped after 60 s because it would otherwise take about an hour.

## route-optimization/

```
cd audit/prototypes/route-optimization
python -m venv .venv && .venv/Scripts/pip install ortools     # (bin/pip on Linux/macOS)
.venv/Scripts/python route_bench.py        # ~4 min -> route_results.json
.venv/Scripts/python route_followup.py     # ~2 min -> route_followup_results.json
```

The warehouse is modelled as a graph: 20 aisles × 50 m, 3 m apart, with cross-aisles at 0/25/50 m.
Dijkstra builds the distance matrix. The scripts compare nearest-neighbour, S-shape, NN+2-opt,
OR-Tools (default solve, and Guided Local Search with 1 s and 3 s limits) and exact Held-Karp
(for 12 items or fewer). They also test a temperature constraint: each frozen item must be at most
40 m of walking from the exit.
