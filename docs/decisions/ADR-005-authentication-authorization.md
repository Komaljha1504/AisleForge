# ADR-005 — Authentication, sessions, RBAC and store isolation

**Status:** Implemented and tested (Phase 3). Evidence: `tests/security/*`, `tests/integration/api-orders.test.ts`,
`audit/test-results/phase3/`.

## Authentication

- **Passwords:** Argon2id (m = 19 MiB, t = 2, p = 1; OWASP baseline) via `@node-rs/argon2`. Hashing runs on a native
  thread pool, not the event loop. Policy: 12–256 characters, must not contain the email's local part. Unknown accounts
  still verify against a dummy hash (equal work), and every failure returns the same `401`.
- **Access token:** JWT HS256, **10 min**, claims `sub, role, store, sid, jti, iss, aud, exp`. Verification uses an
  algorithm allow-list (`HS256` only, so `alg=none` and algorithm confusion are rejected), issuer, audience, expiry,
  and a Zod check of the claim shape (an unknown role is rejected). Clients keep it **in memory only**.
- **Refresh token:** 256-bit opaque random value in an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie.
  Only its SHA-256 is stored. **Rotation on every use; reuse detection** revokes the whole session family. A session's
  absolute lifetime is 12 h (one shift); rotation never extends it.
- **CSRF** for the cookie endpoints (`/auth/refresh`, `/auth/logout`): SameSite=Strict, a mandatory
  `X-CSRF-Protection: 1` header (forms cannot set it; cross-origin fetches need a preflight), and an Origin allow-list check.
- **CORS:** explicit allow-list from `CORS_ORIGINS`. Credentials are only allowed for allow-listed origins, never `*`.
  Preflights from other origins get 403.
- **Brute force:** see the next section (revised after review). Per-IP attempt limits also apply to login and
  registration. **All throttling state is in-process**, so with N replicas the effective limits are up to N×. Phase 7
  adds Redis-backed state, with the in-process implementation as the outage fallback.
- **Audit trail:** `auth_audit_log` (append-only) records login success/failure, rate limiting (with reason), refresh
  reuse, role changes and admin throttle clears.

## Brute-force protection vs lockout abuse (revised after engineering review, 2026-11-21)

**Problem with the first design (measured).** The first implementation locked the _account_ after 5 failures, for
everyone. `tests/security/lockout-abuse.test.ts` run against it showed that 5 wrong guesses from an attacker's IP made
the real user get `429` from a different IP. That is denial of service for the price of 5 requests per 15 minutes, and
there was no recovery path. Evidence: `audit/test-results/phase3/lockout-abuse-BEFORE-fix.json`.

**Options considered**

| Option                                            | Stops online guessing             | Lockout-DoS risk                                                        | Notes                                                                      |
| ------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Account-wide hard lock (original)                 | yes                               | **high**: anyone can lock anyone                                        | rejected                                                                   |
| Temporary lock per (account, source IP)           | yes, per source                   | low: only the attacker's source is locked                               | can be evaded by rotating IPs → needs an account-wide layer                |
| Progressive delays (exponential lock duration)    | yes, cost grows per source        | low                                                                     | bounds attacker throughput without permanent locks                         |
| Account-wide threshold that exempts known sources | yes, against distributed spraying | low for returning users; new devices are slowed during an active attack | residual risk documented below                                             |
| CAPTCHA / step-up challenge / MFA                 | yes                               | low                                                                     | out of scope (no human-verification or MFA infrastructure in this project) |

**Chosen approach** (`apps/api/src/security/loginThrottle.ts`, all values configurable):

1. **Per (account, source) temporary lock.** 5 failures in 15 min lock _that source_ for that account.
2. **Progressive duration.** Repeated locks within 24 h escalate 60 → 120 → 240 → 480 → 900 s (cap). Escalation
   resets after 24 quiet hours. A locked source is refused without checking the password, even if it is correct, so
   the attacker gets no oracle.
3. **Distributed-attack layer.** After 100 failures across all sources within 1 h, attempts from sources that have
   **never logged in successfully** to that account (within 30 days) are refused until the hour passes. Known sources
   keep working.
4. **Recovery.** Locks expire on their own. A successful login clears that source's counter. Admins can clear all of
   an account's throttles via `POST /api/v1/admin/users/:id/unlock-login` (audited). With multiple API replicas
   before Phase 7, the unlock clears only the instance that handled it; this is recorded in the audit entry.
5. **Source identity.** The source is the client IP as Express sees it. `TRUST_PROXY` must equal the real number of
   proxy hops. With the default (`false`), `X-Forwarded-For` is ignored, so clients cannot spoof their way around a
   throttle (tested).

**Residual risks.** A user on a brand-new network _during_ a distributed attack is slowed until the attack window
passes (bounded at 1 h, admin-clearable). Many users behind one NAT share a source: a lock affects them all, but only
for that account. Throttling state is per instance until Phase 7.

**Tests.** `tests/security/lockout-abuse.test.ts`:

- single-source attack does not lock out the real user;
- locked source stays locked even with the correct password;
- distributed attack slows new sources but not known ones;
- admin unlock works and is audited;
- `X-Forwarded-For` is ignored without `TRUST_PROXY`.

`tests/unit/login-throttle.test.ts` covers escalation, expiry, reset, isolation and bounded memory.

## Authorization

- **Function level** (`PERMISSIONS` in `packages/domain/src/identity/authorization.ts`): each route declares one
  permission (customer / picker / supervisor / admin).
- **Store level:** staff resources are addressed by `/stores/:storeId/...` and checked with `assertStoreAccess`
  against the **token's** store claim. A body `storeId` never authorizes anything (strict schemas reject unknown fields).
- **Object level (BOLA):** order reads, lists and cancels go through scoped SQL. Out-of-scope rows return **404**,
  indistinguishable from non-existent ones.
- **Mass assignment:** every input schema is `.strict()`. `/me` can only change `displayName`. Role/store changes go
  through admin-only endpoints; admins cannot change their own role. A role change revokes all of the user's sessions
  in the same transaction.

## Known limitations (accepted, documented)

1. An access token stays valid until it expires (≤ 10 min) after logout or a role change. Refresh is blocked
   immediately. **Decision (review item 3): keep this limitation.** No token denylist or per-request session lookup
   will be added just to close it.
2. Two tabs refreshing with the same cookie at the same instant: the second is treated as reuse and logs the session
   out. The PWA must single-flight refresh (Web Locks) — Phase 4 requirement.
3. Registration reveals whether an email exists (409). Accepted for this project; mitigated by per-IP registration limits.
4. Graceful SIGTERM drain is implemented in `apps/api/src/main.ts` but **not verified**: Windows cannot deliver SIGTERM
   to a child process. Verification is planned in a Linux container (Phase 8/9).
5. **Cookie behaviour has only been verified at the HTTP level** (Set-Cookie attributes asserted by supertest). Real
   browser behaviour is **not yet verified** and is a Phase 4 Playwright requirement:
   - `HttpOnly` cookie invisible to `document.cookie`;
   - `SameSite=Strict` not sent on cross-site requests;
   - `Secure` handling on HTTPS vs `localhost`;
   - `Path` scoping to `/api/v1/auth`;
   - refresh single-flight across tabs.
