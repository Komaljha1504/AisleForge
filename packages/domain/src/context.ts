import type { PgPool } from '@aisleforge/database';
import type { AppConfig, Logger } from '@aisleforge/shared';

export type DomainConfig = Pick<
  AppConfig,
  | 'RESERVATION_TTL_MINUTES'
  | 'MAX_ORDER_LINES'
  | 'MAX_LINE_QTY'
  | 'PG_TX_MAX_ATTEMPTS'
  | 'TASK_LEASE_MINUTES'
  | 'LEASE_RESERVATION_GRACE_MINUTES'
>;

export const defaultDomainConfig: DomainConfig = {
  RESERVATION_TTL_MINUTES: 30,
  TASK_LEASE_MINUTES: 240,
  LEASE_RESERVATION_GRACE_MINUTES: 10,
  MAX_ORDER_LINES: 50,
  MAX_LINE_QTY: 1000,
  PG_TX_MAX_ATTEMPTS: 4,
};

/** Everything a domain operation needs. Pools are injected so the API can use bulkheaded pools. */
export interface DomainContext {
  pool: PgPool;
  config: DomainConfig;
  logger?: Logger;
}

/** Who/why metadata carried into the ledger, outbox and logs. */
export interface Actor {
  actorId: string | null;
  correlationId: string | null;
}
