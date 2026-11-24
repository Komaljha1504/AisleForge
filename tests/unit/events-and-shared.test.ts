import { describe, expect, it } from 'vitest';
import { createEvent, parseEnvelope, Topics } from '@aisleforge/events';
import { backoffMs, createLogger, loadConfig, newId } from '@aisleforge/shared';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACT_PATHS } from '@aisleforge/shared';

describe('event envelope', () => {
  it('creates a valid envelope with topic and partition key', () => {
    const orderId = newId();
    const e = createEvent('order.cancelled', {
      aggregateId: orderId,
      aggregateVersion: 2,
      partitionKey: orderId,
      correlationId: 'corr-1',
      payload: { orderId, storeId: 1, reason: 'customer_request' },
    });
    expect(e.topic).toBe(Topics.orders);
    expect(e.partitionKey).toBe(orderId);
    expect(parseEnvelope(e.envelope)).toMatchObject({
      type: 'order.cancelled',
      schemaVersion: 1,
      aggregateVersion: 2,
    });
  });

  it('refuses to create an event with a malformed payload (producer-side validation)', () => {
    expect(() =>
      createEvent('order.cancelled', {
        aggregateId: 'x',
        aggregateVersion: 1,
        partitionKey: 'x',
        correlationId: null,
        // @ts-expect-error deliberately wrong payload
        payload: { orderId: 'not-a-uuid', storeId: -1 },
      }),
    ).toThrow();
  });

  it('rejects envelopes missing required fields', () => {
    expect(() => parseEnvelope({ type: 'order.placed' })).toThrow();
  });
});

describe('shared utilities', () => {
  it('UUIDv7 ids are time-ordered', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
    expect(a[14]).toBe('7');
  });

  it('backoff is bounded by cap', () => {
    for (let i = 0; i < 20; i++) expect(backoffMs(i, 20, 1000)).toBeLessThanOrEqual(1000);
  });

  it('config refuses to start without DATABASE_URL and never defaults timeouts to 0', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    const cfg = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(cfg.PG_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(cfg.PG_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x@y/z', PG_CONNECTION_TIMEOUT_MS: '0' })).toThrow();
  });

  it('logger redacts credentials', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info(
      {
        password: 'hunter2',
        user: { refreshToken: 'abc' },
        req: { headers: { authorization: 'Bearer xyz' } },
      },
      'login',
    );
    const out = lines.join('');
    expect(out).not.toMatch(/hunter2|abc|Bearer xyz/);
    expect(out).toMatch(/\[REDACTED\]/);
    expect(createLogger('t', { level: 'silent' })).toBeDefined();
  });
});
