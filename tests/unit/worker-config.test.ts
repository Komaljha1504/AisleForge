import { describe, expect, it } from 'vitest';
import { AppError } from '@aisleforge/shared';
import { describeError, loadWorkerConfig, NonRetriableError } from '@aisleforge/worker';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', KAFKA_BROKERS: '127.0.0.1:9092' };

describe('worker configuration', () => {
  it('requires brokers and a database URL, and refuses to start otherwise', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/KAFKA_BROKERS/);
    expect(() => loadWorkerConfig({ KAFKA_BROKERS: base.KAFKA_BROKERS })).toThrow(/DATABASE_URL/);
  });

  it('parses broker lists, roles and defaults', () => {
    const c = loadWorkerConfig({
      ...base,
      KAFKA_BROKERS: 'a:9092, b:9092',
      WORKER_ROLES: 'publisher, order-workflow',
    });
    expect(c.KAFKA_BROKERS).toEqual(['a:9092', 'b:9092']);
    expect(c.WORKER_ROLES).toEqual(['publisher', 'order-workflow']);
    expect(c.KAFKA_TOPIC_PREFIX).toBe('');
    expect(c.CONSUMER_MAX_ATTEMPTS).toBe(5);
    expect(c.KAFKA_DELIVERY_TIMEOUT_MS).toBe(15_000);
  });

  it('rejects unknown roles, an empty role list and unsafe topic prefixes', () => {
    expect(() => loadWorkerConfig({ ...base, WORKER_ROLES: 'publisher,miner' })).toThrow(/WORKER_ROLES/);
    expect(() => loadWorkerConfig({ ...base, WORKER_ROLES: ' , ' })).toThrow(/WORKER_ROLES/);
    expect(() => loadWorkerConfig({ ...base, KAFKA_TOPIC_PREFIX: 'bad prefix/' })).toThrow(
      /KAFKA_TOPIC_PREFIX/,
    );
  });
});

describe('dead-letter error descriptions', () => {
  it('include the error code, details (e.g. SQLSTATE) and the underlying cause', () => {
    const e = new AppError('DB_TIMEOUT', 'Database contention; retry later', {
      details: { sqlstate: '55P03', attempts: 4 },
      cause: new Error('canceling statement due to lock timeout'),
    });
    expect(describeError(e)).toBe(
      'DB_TIMEOUT: Database contention; retry later {"sqlstate":"55P03","attempts":4} (cause: canceling statement due to lock timeout)',
    );
    expect(describeError(new NonRetriableError('order x does not exist'))).toBe('order x does not exist');
    expect(describeError('plain')).toBe('plain');
  });
});
