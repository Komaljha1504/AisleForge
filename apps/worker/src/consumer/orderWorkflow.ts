import {
  cancelPickTaskForOrder,
  completePickTaskForOrder,
  createPickTask,
  planTaskForOrder,
  type PlannedTask,
} from '@aisleforge/domain';
import { Topics, type PayloadOf } from '@aisleforge/events';
import { NonRetriableError, type ConsumerDefinition, type EventHandler } from './runner';

export const ORDER_WORKFLOW_CONSUMER = 'order-workflow';

/**
 * order.placed  → pick task with a planned route (route planned outside the write transaction).
 * order.cancelled → open/claimed task cancelled.
 * order.picked  → task completed.
 * Events for one order share a partition (key = order id) and carry orders.version, so they are applied in order
 * and replays of superseded events are skipped as stale.
 */
export function orderWorkflowConsumer(opts: {
  routeTimeBudgetMs: number;
  failOptimizer?: () => boolean;
}): ConsumerDefinition {
  const placed: EventHandler<PlannedTask> = {
    async prepare({ envelope }, pool) {
      const p = envelope.payload as PayloadOf<'order.placed'>;
      return planTaskForOrder(pool, p.orderId, p.storeId, {
        timeBudgetMs: opts.routeTimeBudgetMs,
        failOptimizer: opts.failOptimizer?.() ?? false,
      });
    },
    async apply(c, { envelope, logger }, planned) {
      const p = envelope.payload as PayloadOf<'order.placed'>;
      const task = await createPickTask(c, {
        orderId: p.orderId,
        storeId: p.storeId,
        planned,
        correlationId: envelope.correlationId,
        sourceEventId: envelope.eventId,
      });
      if (task) {
        logger.info(
          {
            orderId: p.orderId,
            pickTaskId: task.id,
            routeStatus: planned.routeStatus,
            algorithm: planned.route.algorithm,
          },
          'pick task created',
        );
        return 'applied';
      }
      const o = await c.query<{ status: string; store_id: number }>(
        'SELECT status, store_id FROM orders WHERE id = $1',
        [p.orderId],
      );
      const order = o.rows[0];
      if (!order) throw new NonRetriableError(`order ${p.orderId} does not exist`);
      if (order.store_id !== p.storeId)
        throw new NonRetriableError(
          `order ${p.orderId} belongs to store ${order.store_id}, event says ${p.storeId}`,
        );
      // Already has a task, or the order was cancelled/advanced before this event was consumed: nothing to do.
      logger.info(
        { orderId: p.orderId, orderStatus: order.status },
        'no pick task created (already exists or order closed)',
      );
      return 'ignored';
    },
  };
  const cancelled: EventHandler<undefined> = {
    async apply(c, { envelope }) {
      const p = envelope.payload as PayloadOf<'order.cancelled'>;
      return (await cancelPickTaskForOrder(c, p.orderId)) ? 'applied' : 'ignored';
    },
  };
  const picked: EventHandler<undefined> = {
    async apply(c, { envelope }) {
      const p = envelope.payload as PayloadOf<'order.picked'>;
      return (await completePickTaskForOrder(c, p.orderId)) ? 'applied' : 'ignored';
    },
  };
  return {
    name: ORDER_WORKFLOW_CONSUMER,
    topics: [Topics.orders],
    versionCheck: true,
    handlers: {
      'order.placed': placed as EventHandler<never>,
      'order.cancelled': cancelled as EventHandler<never>,
      'order.picked': picked as EventHandler<never>,
    },
  };
}
