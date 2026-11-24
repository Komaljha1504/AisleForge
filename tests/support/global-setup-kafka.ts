import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    kafkaBrokers: string;
  }
}

/**
 * The `kafka` test project runs against a REAL broker (docker compose up -d kafka). There is no mock and no skip:
 * if the broker is unreachable the whole project fails here with an actionable message.
 */
export default async function setup(project: TestProject): Promise<void> {
  const brokers = process.env.KAFKA_BROKERS ?? '127.0.0.1:9092';
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: brokers.split(','), logLevel: KafkaJS.logLevel.NOTHING },
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.listTopics({ timeout: 10_000 });
  } catch (err) {
    throw new Error(
      `Kafka broker not reachable at ${brokers}. Start it with: docker compose up -d kafka ` +
        `(cause: ${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
  project.provide('kafkaBrokers', brokers);
}
