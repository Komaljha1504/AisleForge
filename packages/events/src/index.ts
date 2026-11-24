import { z } from 'zod';
import { newId } from '@aisleforge/shared';

/**
 * Event envelope (ADR-003). Every event published to Kafka has exactly this shape; consumers validate it
 * before acting. `aggregateVersion` lets consumers discard stale/out-of-order events for the same aggregate.
 */
export const EnvelopeSchema = z.object({
  eventId: z.uuid(),
  type: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.string().nullable(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const Topics = {
  orders: 'aisleforge.order.events',
  inventory: 'aisleforge.inventory.events',
} as const;
export type Topic = (typeof Topics)[keyof typeof Topics];
export const deadLetterTopic = (topic: string): string => `${topic}.dlt`;

const OrderLinePayload = z.object({
  lineId: z.uuid(),
  lineNo: z.number().int().positive(),
  sku: z.string(),
  qty: z.number().int().positive(),
  reservationId: z.uuid(),
});

export const EventPayloads = {
  'order.placed': z.object({
    orderId: z.uuid(),
    storeId: z.number().int().positive(),
    customerId: z.uuid(),
    lines: z.array(OrderLinePayload).min(1),
    reservationExpiresAt: z.iso.datetime({ offset: true }),
  }),
  'order.cancelled': z.object({
    orderId: z.uuid(),
    storeId: z.number().int().positive(),
    reason: z.string(),
  }),
  'order.picked': z.object({
    orderId: z.uuid(),
    storeId: z.number().int().positive(),
    shortLines: z.number().int().nonnegative(),
  }),
  'reservation.closed': z.object({
    reservationId: z.uuid(),
    orderId: z.uuid(),
    storeId: z.number().int().positive(),
    sku: z.string(),
    qty: z.number().int().positive(),
    status: z.enum(['picked', 'released', 'expired']),
    pickedQty: z.number().int().nonnegative(),
    shortQty: z.number().int().nonnegative(),
  }),
  'inventory.balance_changed': z.object({
    storeId: z.number().int().positive(),
    sku: z.string(),
    onHand: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    movement: z.string(),
  }),
} as const;
export type EventType = keyof typeof EventPayloads;
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

interface EventDefinition {
  topic: Topic;
  schemaVersion: number;
  aggregateType: string;
}
export const EventDefinitions: Record<EventType, EventDefinition> = {
  'order.placed': { topic: Topics.orders, schemaVersion: 1, aggregateType: 'order' },
  'order.cancelled': { topic: Topics.orders, schemaVersion: 1, aggregateType: 'order' },
  'order.picked': { topic: Topics.orders, schemaVersion: 1, aggregateType: 'order' },
  'reservation.closed': { topic: Topics.orders, schemaVersion: 1, aggregateType: 'reservation' },
  'inventory.balance_changed': {
    topic: Topics.inventory,
    schemaVersion: 1,
    aggregateType: 'inventory_balance',
  },
};

/** A fully-formed event ready to be written to the outbox in the caller's transaction. */
export interface OutboxEvent {
  envelope: Envelope;
  topic: Topic;
  /** Kafka key: events that must stay ordered relative to each other share a key (same partition). */
  partitionKey: string;
}

export function createEvent<T extends EventType>(
  type: T,
  args: {
    aggregateId: string;
    aggregateVersion: number;
    partitionKey: string;
    correlationId: string | null;
    payload: PayloadOf<T>;
    occurredAt?: Date;
  },
): OutboxEvent {
  const def = EventDefinitions[type];
  const payload = EventPayloads[type].parse(args.payload); // producer-side validation: never publish malformed events
  return {
    topic: def.topic,
    partitionKey: args.partitionKey,
    envelope: {
      eventId: newId(),
      type,
      schemaVersion: def.schemaVersion,
      aggregateType: def.aggregateType,
      aggregateId: args.aggregateId,
      aggregateVersion: args.aggregateVersion,
      occurredAt: (args.occurredAt ?? new Date()).toISOString(),
      correlationId: args.correlationId,
      payload,
    },
  };
}

/** Consumer-side parsing: envelope first, then the typed payload for known types. */
export function parseEnvelope(raw: unknown): Envelope {
  return EnvelopeSchema.parse(raw);
}
export function parsePayload<T extends EventType>(type: T, payload: unknown): PayloadOf<T> {
  return EventPayloads[type].parse(payload) as PayloadOf<T>;
}
export const isKnownEventType = (t: string): t is EventType => Object.hasOwn(EventPayloads, t);
