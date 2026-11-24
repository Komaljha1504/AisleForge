import { describe, expect, it } from 'vitest';
import { LoginThrottle, type LoginThrottlePolicy } from '../../apps/api/src/security/loginThrottle';

const policy: LoginThrottlePolicy = {
  perSourceMaxFailures: 5,
  failureWindowSeconds: 900,
  baseLockSeconds: 60,
  maxLockSeconds: 900,
  lockEscalationSeconds: 86_400,
  accountMaxFailures: 100,
  accountWindowSeconds: 3600,
  knownSourceTtlSeconds: 30 * 86_400,
};

function setup(p: Partial<LoginThrottlePolicy> = {}) {
  let now = 1_000_000;
  const t = new LoginThrottle({ ...policy, ...p }, () => now);
  return { t, advance: (s: number) => (now += s * 1000) };
}
const fail = (t: LoginThrottle, n: number, acct = 'a@x', src = '1.1.1.1') => {
  for (let i = 0; i < n; i++) t.recordFailure(acct, src);
};

describe('LoginThrottle', () => {
  it('locks a source temporarily after the threshold and unlocks when the lock expires', () => {
    const { t, advance } = setup();
    fail(t, 4);
    expect(t.check('a@x', '1.1.1.1').allowed).toBe(true);
    fail(t, 1);
    expect(t.check('a@x', '1.1.1.1')).toMatchObject({
      allowed: false,
      reason: 'source_locked',
      retryAfterSeconds: 60,
    });
    advance(59);
    expect(t.check('a@x', '1.1.1.1').allowed).toBe(false);
    advance(2);
    expect(t.check('a@x', '1.1.1.1').allowed).toBe(true);
  });

  it('escalates progressively (60 → 120 → 240 → 480 → 900 s cap) on repeated locks within the escalation window', () => {
    const { t, advance } = setup();
    const durations: number[] = [];
    for (let k = 0; k < 6; k++) {
      fail(t, 5);
      const d = t.check('a@x', '1.1.1.1');
      durations.push(d.retryAfterSeconds);
      advance(d.retryAfterSeconds + 1);
    }
    expect(durations).toEqual([60, 120, 240, 480, 900, 900]);
  });

  it('resets escalation after a quiet escalation window', () => {
    const { t, advance } = setup();
    fail(t, 5);
    advance(61);
    fail(t, 5);
    expect(t.check('a@x', '1.1.1.1').retryAfterSeconds).toBe(120);
    advance(86_401);
    fail(t, 5);
    expect(t.check('a@x', '1.1.1.1').retryAfterSeconds).toBe(60);
  });

  it('failures spread beyond the failure window do not lock', () => {
    const { t, advance } = setup();
    for (let i = 0; i < 10; i++) {
      t.recordFailure('a@x', '1.1.1.1');
      advance(200); // 4 failures per 800 s < 5 per 900 s
      if (i % 4 === 3) advance(900);
    }
    expect(t.check('a@x', '1.1.1.1').allowed).toBe(true);
  });

  it('a lock on one source never affects another source of the same account', () => {
    const { t } = setup();
    fail(t, 50, 'a@x', '6.6.6.6');
    expect(t.check('a@x', '6.6.6.6').allowed).toBe(false);
    expect(t.check('a@x', '7.7.7.7').allowed).toBe(true);
  });

  it('account-wide threshold blocks unknown sources only; known sources expire after their TTL', () => {
    const { t, advance } = setup({ accountMaxFailures: 10 });
    t.recordSuccess('a@x', 'home');
    for (let i = 0; i < 10; i++) t.recordFailure('a@x', `bot-${i}`);
    expect(t.check('a@x', 'new-place')).toMatchObject({ allowed: false, reason: 'account_under_attack' });
    expect(t.check('a@x', 'home').allowed).toBe(true);
    advance(3601); // account window passes → counter resets
    expect(t.check('a@x', 'new-place').allowed).toBe(true);
  });

  it("a successful login clears that source's failure count", () => {
    const { t } = setup();
    fail(t, 4);
    t.recordSuccess('a@x', '1.1.1.1');
    fail(t, 4);
    expect(t.check('a@x', '1.1.1.1').allowed).toBe(true);
  });

  it('admin clear removes source locks and the account-wide counter', () => {
    const { t } = setup({ accountMaxFailures: 3 });
    fail(t, 5, 'a@x', 's1');
    fail(t, 5, 'a@x', 's2');
    expect(t.clearAccount('a@x')).toBe(2);
    expect(t.check('a@x', 's1').allowed).toBe(true);
    expect(t.check('a@x', 'new').allowed).toBe(true);
  });

  it('memory is bounded', () => {
    let now = 0;
    const t = new LoginThrottle(policy, () => now, 100);
    for (let i = 0; i < 1000; i++) t.recordFailure(`u${i}@x`, `s${i}`);
    now += 1;
    expect(t.peekSource('u0@x', 's0')).toBeUndefined(); // evicted
    expect(t.peekSource('u999@x', 's999')).toBeDefined();
  });
});
