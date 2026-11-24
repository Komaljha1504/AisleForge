# ADR-001 — Modular monolith with separate API and worker processes

**Status:** Accepted (Phase 0) · **Supersedes:** audit §13.2 sketch where noted

## Decision

- One TypeScript codebase (pnpm workspace) deployed as **two process roles** from one image: `api` (HTTP, stateless)
  and `worker` (outbox publisher, Kafka consumers, reservation-expiry job). The PWA is a separate static build.
- Strict domain modules in `packages/domain` (inventory, orders; picking, sync, identity added in later phases).
  HTTP controllers contain no business logic; they validate input, resolve the principal, call a domain function.
- PostgreSQL is the only source of truth. Kafka carries asynchronous reactions and is never on the reservation path.
  Redis (Phase 7) is a non-authoritative cache/rate-limit layer.
- Python/OR-Tools only if Phase 5 measurements justify it for batching/capacity problems.

## Repository layout deviation

The suggested root folder `aisleforge/` is the **workspace root itself** (`RetailFlow/`, not renamed without
approval). This keeps the existing `audit/` evidence in place. Package names, docs, Docker service names and env
vars use **AisleForge**.

## Tooling decisions

| Choice                                                                                                      | Reason                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm workspaces, packages export TypeScript source (`exports: ./src/index.ts`), `moduleResolution: Bundler` | No per-package build step in development; production images are bundled (Phase 8)                                                                        |
| Vitest (Jest-equivalent)                                                                                    | Native TS/ESM; `projects` split unit vs real-database tests                                                                                              |
| Real PostgreSQL in tests: `embedded-postgres` (PostgreSQL 18.7 binaries) by default, or `TEST_DATABASE_URL` | Docker is not installed; the embedded server is a genuine PostgreSQL, not an emulation. CI will use a Postgres service container via `TEST_DATABASE_URL` |
| `io_method=sync` for the embedded test server                                                               | PostgreSQL 18 I/O worker processes outlived the postmaster on Windows and leaked                                                                         |
| Forward-only SQL migrations with checksum + advisory lock (own ~60-line runner)                             | Transparent, no ORM; concurrent deployers cannot race                                                                                                    |
| Zod 4 for config, API input and event schemas; `.strict()` objects                                          | Closes mass assignment; one schema source shared by producer and consumer                                                                                |
| Pino structured JSON logs with central redaction                                                            | Required diagnostics without a monitoring stack                                                                                                          |
| UUIDv7 identifiers                                                                                          | Time-ordered, index-friendly, collision-resistant (offline op ids too)                                                                                   |

## Consequences

The API and worker share code and deploy independently. A failing worker never blocks order placement. A failing
API never stops event processing.
