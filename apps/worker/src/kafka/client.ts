import { KafkaJS } from '@confluentinc/kafka-javascript';
import { deadLetterTopic, Topics } from '@aisleforge/events';
import type { Logger } from '@aisleforge/shared';
import type { EventProducer, OutboundMessage } from '../outbox/publisher';

export type KafkaClient = KafkaJS.Kafka;
export type KafkaProducer = KafkaJS.Producer;
export type KafkaConsumer = KafkaJS.Consumer;
export type KafkaAdmin = KafkaJS.Admin;

export interface KafkaSettings {
  brokers: string[];
  clientId: string;
  deliveryTimeoutMs: number;
  sessionTimeoutMs: number;
}

/** Routes librdkafka/client logs into the structured application logger (warn and above by default). */
function kafkaLogger(logger: Logger): KafkaJS.Logger {
  const make = (ns: string): KafkaJS.Logger => {
    const child = logger.child({ component: 'kafka', ns });
    return {
      info: (m, extra) => child.debug(extra ?? {}, m),
      debug: (m, extra) => child.trace(extra ?? {}, m),
      warn: (m, extra) => child.warn(extra ?? {}, m),
      error: (m, extra) => child.error(extra ?? {}, m),
      namespace: (n) => make(`${ns}.${n}`),
      setLogLevel: () => undefined,
    };
  };
  return make('client');
}

export function createKafka(s: KafkaSettings, logger: Logger): KafkaClient {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: s.brokers,
      clientId: s.clientId,
      logLevel: KafkaJS.logLevel.WARN,
      logger: kafkaLogger(logger),
    },
  });
}

/**
 * Real Kafka producer behind the outbox publisher's EventProducer interface.
 *
 * - acks=all and enable.idempotence: the broker acknowledges only fully replicated writes, and internal retries
 *   cannot reorder or duplicate messages within a partition. (Exactly-once *effects* still come from consumer
 *   deduplication; a crash between ack and the outbox mark republishes — ADR-003.)
 * - `send` resolves only after every message in the batch has a delivery report; any failure rejects the whole
 *   call so the publisher marks nothing (it may have been partially delivered — consumers dedupe).
 * - Bounded: message.timeout.ms caps how long a send can wait for a broker (no infinite hang while Kafka is down).
 * - A producer that reports a fatal error is discarded and recreated on the next send.
 */
export class KafkaEventProducer implements EventProducer {
  private producer: KafkaProducer | null = null;
  private connecting: Promise<KafkaProducer> | null = null;
  lastError: string | null = null;
  lastAckAt: Date | null = null;
  sentMessages = 0;

  constructor(
    private readonly kafka: KafkaClient,
    private readonly settings: KafkaSettings,
    private readonly logger: Logger,
  ) {}

  get connected(): boolean {
    return this.producer !== null;
  }

  private async get(): Promise<KafkaProducer> {
    if (this.producer) return this.producer;
    this.connecting ??= (async () => {
      const p = this.kafka.producer({
        'enable.idempotence': true,
        acks: -1,
        'message.timeout.ms': this.settings.deliveryTimeoutMs,
        'request.timeout.ms': Math.min(this.settings.deliveryTimeoutMs, 10_000),
        'compression.type': 'lz4',
        'linger.ms': 5,
        kafkaJS: { allowAutoTopicCreation: false },
      } as KafkaJS.ProducerConstructorConfig);
      try {
        await p.connect();
      } catch (e) {
        await p.disconnect().catch(() => undefined);
        throw e;
      }
      this.producer = p;
      return p;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async send(messages: OutboundMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const byTopic = new Map<string, KafkaJS.Message[]>();
    for (const m of messages) {
      const list = byTopic.get(m.topic) ?? [];
      list.push({ key: m.key, value: m.value, headers: m.headers });
      byTopic.set(m.topic, list);
    }
    await this.sendRaw([...byTopic].map(([topic, msgs]) => ({ topic, messages: msgs })));
  }

  /** Sends arbitrary messages (DLT copies, replays) with the same acknowledgement guarantees. */
  async sendRaw(topicMessages: KafkaJS.TopicMessages[]): Promise<void> {
    const p = await this.get();
    try {
      await p.sendBatch({ topicMessages });
      this.lastError = null;
      this.lastAckAt = new Date();
      this.sentMessages += topicMessages.reduce((n, t) => n + t.messages.length, 0);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      if (isFatal(e)) {
        this.logger.error({ err: e }, 'fatal producer error; producer will be recreated');
        this.producer = null;
        await p.disconnect().catch(() => undefined);
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    const p = this.producer;
    this.producer = null;
    if (p) await p.disconnect().catch(() => undefined);
  }
}

function isFatal(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { fatal?: unknown; isFatal?: unknown };
  return o.fatal === true || o.isFatal === true;
}

/** Topics the application owns, plus their dead-letter topics. Created explicitly; auto-creation is disabled. */
export const APPLICATION_TOPICS = [
  Topics.orders,
  Topics.inventory,
  deadLetterTopic(Topics.orders),
  deadLetterTopic(Topics.inventory),
];

export async function ensureTopics(
  admin: KafkaAdmin,
  opts: { partitions: number; replicationFactor: number; topics?: string[] },
): Promise<string[]> {
  const wanted = opts.topics ?? APPLICATION_TOPICS;
  const existing = new Set(await admin.listTopics({ timeout: 10_000 }));
  const missing = wanted.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    await createTopics(admin, missing, opts);
  }
  // A consumer that subscribes before the broker has propagated new topic metadata gets "Unknown topic or
  // partition" and (observed 2026-11-22, e2e run) may never receive an assignment. Wait until every topic reports
  // all its partitions with a leader — bounded, and loud if it does not happen.
  await waitForTopics(admin, wanted, 30_000);
  return missing;
}

async function waitForTopics(admin: KafkaAdmin, topics: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const meta = await admin.fetchTopicMetadata({ topics, timeout: 5_000 });
      const ready = topics.every((t) => {
        const m = meta.find((x) => x.name === t);
        return m !== undefined && m.partitions.length > 0 && m.partitions.every((p) => p.leader >= 0);
      });
      if (ready) return;
      last = 'partitions without a leader';
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) throw new Error(`Kafka topics not ready after ${timeoutMs} ms: ${last}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createTopics(
  admin: KafkaAdmin,
  missing: string[],
  opts: { partitions: number; replicationFactor: number },
): Promise<void> {
  await admin.createTopics({
    timeout: 15_000,
    topics: missing.map((topic) => ({
      topic,
      numPartitions: opts.partitions,
      replicationFactor: opts.replicationFactor,
      // Dead-letter topics keep messages for 30 days; the database row is the durable record for replay.
      configEntries: topic.endsWith('.dlt') ? [{ name: 'retention.ms', value: String(30 * 86_400_000) }] : [],
    })),
  });
}

export interface PartitionLag {
  topic: string;
  partition: number;
  committed: number | null;
  high: number;
  lag: number;
}

/**
 * Lag of the partitions assigned to ONE consumer = high watermark − that consumer's committed offset.
 *
 * D-K5 root cause (2026-11-23, gdb backtrace in audit/test-results/phase2/k5-investigation/linux-repro-gdb-*):
 * the previous version read committed offsets with the ADMIN client (`admin.fetchOffsets` → librdkafka
 * ListConsumerGroupOffsets). When that response carries a coordinator error (fresh cluster: `__consumer_offsets`
 * just created; or a coordinator reload after a broker stall), librdkafka 2.16.0's `rd_kafka_handle_OffsetFetch`
 * calls `rd_kafka_cgrp_op` on the admin client, which has no consumer group → SIGSEGV on the `rdk:main` thread.
 * The worker never calls the admin offset fetch any more: committed offsets come from the consumer itself
 * (`committed()` → rd_kafka_committed, through its own consumer group), high watermarks from ListOffsets.
 * Each worker reports only its own assignment, so summing across workers no longer double-counts.
 */
export async function consumerLag(
  admin: KafkaAdmin,
  source: {
    assignment(): { topic: string; partition: number }[];
    committed(): Promise<{ topic: string; partition: number; offset: string }[]>;
  },
): Promise<PartitionLag[]> {
  const assigned = source.assignment();
  if (assigned.length === 0) return [];
  const committed = await source.committed();
  const out: PartitionLag[] = [];
  for (const topic of [...new Set(assigned.map((a) => a.topic))]) {
    const offsets = await admin.fetchTopicOffsets(topic, {
      timeout: 5_000,
      isolationLevel: KafkaJS.IsolationLevel.READ_UNCOMMITTED,
    } as never);
    for (const o of offsets) {
      if (!assigned.some((a) => a.topic === topic && a.partition === o.partition)) continue;
      const high = Number(o.high);
      const low = Number(o.low);
      const raw = committed.find((c) => c.topic === topic && c.partition === o.partition)?.offset;
      const cn = raw === undefined || Number(raw) < 0 ? null : Number(raw);
      out.push({ topic, partition: o.partition, committed: cn, high, lag: Math.max(0, high - (cn ?? low)) });
    }
  }
  return out;
}
