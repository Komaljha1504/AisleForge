/**
 * K1 — Kafka producer adapter against a real broker: acknowledged delivery, key → partition stability, per-key
 * ordering, header propagation, and a bounded failure (no fake success) when the broker cannot accept the write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@aisleforge/shared';
import { createKafka, ensureTopics, KafkaEventProducer, type OutboundMessage } from '@aisleforge/worker';
import { deleteTopicsWithPrefix, kafkaBrokers, readTopic, uniquePrefix } from '../support/kafka';
import { writeEvidence } from '../support/db';

const prefix = uniquePrefix('k1');
const topic = `${prefix}roundtrip`;
const logger = createLogger('k1', { level: 'error' });
const settings = () => ({
  brokers: kafkaBrokers().split(','),
  clientId: 'k1',
  deliveryTimeoutMs: 4000,
  sessionTimeoutMs: 6000,
});
let producer: KafkaEventProducer;
const evidence: Record<string, unknown> = {};

beforeAll(async () => {
  const kafka = createKafka(settings(), logger);
  const admin = kafka.admin();
  await admin.connect();
  await ensureTopics(admin, { partitions: 3, replicationFactor: 1, topics: [topic] });
  await admin.disconnect();
  producer = new KafkaEventProducer(kafka, settings(), logger);
});
afterAll(async () => {
  await producer.close();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase2', 'K1-producer', evidence);
});

describe('K1 Kafka producer adapter (real broker)', () => {
  it('delivers acknowledged messages with keys and headers; each key stays on one partition, in order', async () => {
    const keys = ['order-a', 'order-b', 'order-c', 'order-d', 'order-e'];
    const msgs: OutboundMessage[] = [];
    for (let seq = 0; seq < 40; seq++) {
      const key = keys[seq % keys.length]!;
      msgs.push({
        outboxId: seq,
        topic,
        key,
        value: JSON.stringify({ seq, key }),
        headers: { 'event-id': `e-${seq}`, 'correlation-id': `corr-${key}` },
      });
    }
    const t0 = performance.now();
    await producer.send(msgs.slice(0, 20));
    await producer.send(msgs.slice(20));
    const ackMs = performance.now() - t0;
    const got = await readTopic(topic, 40);
    expect(got).toHaveLength(40);
    const partitionsByKey = new Map<string, Set<number>>();
    for (const m of got) {
      const set = partitionsByKey.get(m.key!) ?? new Set<number>();
      set.add(m.partition);
      partitionsByKey.set(m.key!, set);
      expect(m.headers['correlation-id']).toBe(`corr-${m.key}`);
      expect(m.headers['event-id']).toBe(`e-${(JSON.parse(m.value!) as { seq: number }).seq}`);
    }
    for (const set of partitionsByKey.values()) expect(set.size).toBe(1);
    for (const key of keys) {
      const seqs = got
        .filter((m) => m.key === key)
        .sort((a, b) => a.offset - b.offset)
        .map((m) => (JSON.parse(m.value!) as { seq: number }).seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
    evidence.roundtrip = {
      messages: 40,
      ackMsForTwoBatches: Math.round(ackMs),
      partitionsUsed: [...new Set(got.map((m) => m.partition))].sort(),
      keyToPartition: Object.fromEntries([...partitionsByKey].map(([k, s]) => [k, [...s][0]])),
    };
  });

  it('rejects (within the delivery timeout) instead of reporting success when the write cannot be acknowledged', async () => {
    const t0 = performance.now();
    const err = await producer
      .send([{ outboxId: 1, topic: `${prefix}does-not-exist`, key: 'k', value: '{}', headers: {} }])
      .then(() => null)
      .catch((e: unknown) => e);
    const elapsed = performance.now() - t0;
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(15_000);
    evidence.unacknowledgeable = { rejected: true, elapsedMs: Math.round(elapsed), error: String(err) };
  });
});
