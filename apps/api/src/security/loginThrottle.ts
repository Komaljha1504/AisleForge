/**
 * Login throttling designed against BOTH brute force and lockout-as-denial-of-service (ADR-005 §Brute force).
 *
 * 1. Per (account, source IP): after `perSourceMaxFailures` failures in `failureWindowSeconds`, THAT source is locked
 *    temporarily. Repeated locks within `lockEscalationSeconds` double the duration (progressive), capped at
 *    `maxLockSeconds`. Other sources — e.g. the real user on their own network — are unaffected.
 * 2. Per account across all sources: once `accountMaxFailures` failures accumulate in `accountWindowSeconds`
 *    (a distributed attack), further attempts are refused WITHOUT checking the password — except from sources where
 *    this account has logged in successfully before ("known sources"), so the legitimate user keeps access.
 * 3. Recovery: locks expire on their own; an admin can clear an account's throttles (audited).
 *
 * In-process state (per API instance). Phase 7 moves it to Redis with this class as the outage fallback.
 */
export interface LoginThrottlePolicy {
  perSourceMaxFailures: number;
  failureWindowSeconds: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
  lockEscalationSeconds: number;
  accountMaxFailures: number;
  accountWindowSeconds: number;
  knownSourceTtlSeconds: number;
}

export type ThrottleReason = 'source_locked' | 'account_under_attack';

/** Implemented by LoginThrottle (in-process) and RedisLoginThrottle (shared, Phase 7). Callers always await. */
export interface LoginGuard {
  check(account: string, source: string): ThrottleDecision | Promise<ThrottleDecision>;
  recordFailure(account: string, source: string): void | Promise<void>;
  recordSuccess(account: string, source: string): void | Promise<void>;
  clearAccount(account: string): number | Promise<number>;
}

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  reason: ThrottleReason | null;
}

interface SourceState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  locks: number;
  firstLockAt: number;
}
interface AccountState {
  failures: number;
  windowStart: number;
  known: Map<string, number>; // source -> expiresAt
}

export class LoginThrottle {
  private readonly sources = new Map<string, SourceState>();
  private readonly accounts = new Map<string, AccountState>();

  constructor(
    private readonly policy: LoginThrottlePolicy,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 200_000,
  ) {}

  private sKey = (account: string, source: string) => `${account}\u0000${source}`;
  private secondsUntil = (t: number) => Math.max(1, Math.ceil((t - this.now()) / 1000));

  check(account: string, source: string): ThrottleDecision {
    const now = this.now();
    const s = this.sources.get(this.sKey(account, source));
    if (s && s.lockedUntil > now)
      return { allowed: false, retryAfterSeconds: this.secondsUntil(s.lockedUntil), reason: 'source_locked' };
    const a = this.account(account);
    if (a && a.failures >= this.policy.accountMaxFailures && !this.isKnown(a, source)) {
      return {
        allowed: false,
        retryAfterSeconds: this.secondsUntil(a.windowStart + this.policy.accountWindowSeconds * 1000),
        reason: 'account_under_attack',
      };
    }
    return { allowed: true, retryAfterSeconds: 0, reason: null };
  }

  recordFailure(account: string, source: string): void {
    const now = this.now();
    const key = this.sKey(account, source);
    let s = this.sources.get(key);
    if (!s) {
      s = { failures: 0, windowStart: now, lockedUntil: 0, locks: 0, firstLockAt: 0 };
      this.put(this.sources, key, s);
    }
    if (now - s.windowStart > this.policy.failureWindowSeconds * 1000) {
      s.failures = 0;
      s.windowStart = now;
    }
    s.failures++;
    if (s.failures >= this.policy.perSourceMaxFailures) {
      if (s.locks === 0 || now - s.firstLockAt > this.policy.lockEscalationSeconds * 1000) {
        s.locks = 0;
        s.firstLockAt = now;
      }
      s.locks++;
      const seconds = Math.min(this.policy.baseLockSeconds * 2 ** (s.locks - 1), this.policy.maxLockSeconds);
      s.lockedUntil = now + seconds * 1000;
      s.failures = 0;
      s.windowStart = now;
    }
    let a = this.account(account);
    if (!a) {
      a = { failures: 0, windowStart: now, known: new Map() };
      this.put(this.accounts, account, a);
    }
    a.failures++;
  }

  recordSuccess(account: string, source: string): void {
    this.sources.delete(this.sKey(account, source));
    let a = this.account(account);
    if (!a) {
      a = { failures: 0, windowStart: this.now(), known: new Map() };
      this.put(this.accounts, account, a);
    }
    a.known.set(source, this.now() + this.policy.knownSourceTtlSeconds * 1000);
    if (a.known.size > 20) a.known.delete(a.known.keys().next().value as string); // bound per-account memory
  }

  /** Admin recovery: clears every source lock and the account-wide counter (known sources are kept). */
  clearAccount(account: string): number {
    let cleared = 0;
    const prefix = `${account}\u0000`;
    for (const k of [...this.sources.keys()])
      if (k.startsWith(prefix)) {
        this.sources.delete(k);
        cleared++;
      }
    const a = this.accounts.get(account);
    if (a) {
      a.failures = 0;
      a.windowStart = this.now();
    }
    return cleared;
  }

  /** Lock duration that the next lock of this source would receive (for diagnostics/tests). */
  peekSource(account: string, source: string): Readonly<SourceState> | undefined {
    return this.sources.get(this.sKey(account, source));
  }

  private account(account: string): AccountState | undefined {
    const a = this.accounts.get(account);
    if (a && this.now() - a.windowStart > this.policy.accountWindowSeconds * 1000) {
      a.failures = 0;
      a.windowStart = this.now();
    }
    return a;
  }

  private isKnown(a: AccountState, source: string): boolean {
    const exp = a.known.get(source);
    return exp !== undefined && exp > this.now();
  }

  private put<V>(m: Map<string, V>, k: string, v: V): void {
    if (m.size >= this.maxEntries) m.delete(m.keys().next().value as string);
    m.set(k, v);
  }
}
