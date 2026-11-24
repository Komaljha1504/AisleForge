import { Router } from 'express';
import {
  adjustStock,
  assertStoreAccess,
  cancelOrder,
  changeUserRole,
  createStaffUser,
  getBalance,
  getOrderForPrincipal,
  auditAuth,
  getUser,
  listOrdersForPrincipal,
  listUsers,
  placeOrder,
  restock,
  updateDisplayName,
  type DomainContext,
} from '@aisleforge/domain';
import { AppError } from '@aisleforge/shared';
import {
  AdjustRequestSchema,
  AdminChangeRoleSchema,
  AdminCreateUserSchema,
  CancelOrderRequestSchema,
  IdempotencyKeySchema,
  ListOrdersQuerySchema,
  ListUsersQuerySchema,
  PlaceOrderRequestSchema,
  RestockRequestSchema,
  StoreSkuParamsSchema,
  UpdateMeRequestSchema,
  UuidParamSchema,
} from '@aisleforge/validation';
import { parse, permit, principalOf } from '../http/middleware';
import type { AppPools } from '../app';
import type { LoginGuard } from '../security/loginThrottle';

/** All routes here are mounted behind `authenticate`. Each declares its permission; store/object scope is enforced
 *  in the domain query or via assertStoreAccess — a permission alone never grants cross-store access. */
export function resourceRoutes(pools: AppPools, ordersCtx: DomainContext, loginThrottle: LoginGuard): Router {
  const r = Router();
  const actor = (req: { principal?: { userId: string }; correlationId: string }) => ({
    actorId: req.principal?.userId ?? null,
    correlationId: req.correlationId,
  });

  // ---- self ------------------------------------------------------------------------------------------------------
  r.get('/me', async (req, res) => {
    const user = await getUser(pools.orders, principalOf(req).userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Account no longer active');
    res.json({ user });
  });
  r.patch('/me', async (req, res) => {
    const body = parse(UpdateMeRequestSchema, req.body); // strict: role/storeId/email are rejected
    res.json({ user: await updateDisplayName(pools.orders, principalOf(req).userId, body.displayName) });
  });

  // ---- admin -----------------------------------------------------------------------------------------------------
  r.get('/admin/users', permit('users:manage'), async (req, res) => {
    const q = parse(ListUsersQuerySchema, req.query);
    res.json({ users: await listUsers(pools.orders, q) });
  });
  r.post('/admin/users', permit('users:manage'), async (req, res) => {
    const body = parse(AdminCreateUserSchema, req.body);
    res.status(201).json({ user: await createStaffUser(pools.orders, principalOf(req), body) });
  });
  /** Recovery path for login throttling: clears every source lock and the account-wide counter (audited). */
  r.post('/admin/users/:id/unlock-login', permit('users:manage'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    const { rows } = await pools.orders.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      id,
    ]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'User not found');
    const cleared = await loginThrottle.clearAccount(rows[0].email);
    await auditAuth(pools.orders, {
      event: 'login_throttle_cleared',
      success: true,
      userId: id,
      actorId: principalOf(req).userId,
      detail: { sourceLocksCleared: cleared, scope: 'this_api_instance' },
    });
    res.status(204).end();
  });
  r.patch('/admin/users/:id/role', permit('users:manage'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    const body = parse(AdminChangeRoleSchema, req.body);
    res.json({ user: await changeUserRole(pools.orders, principalOf(req), { userId: id, ...body }) });
  });

  // ---- orders ----------------------------------------------------------------------------------------------------
  r.post('/orders', permit('orders:place'), async (req, res) => {
    const p = principalOf(req);
    const key = parse(IdempotencyKeySchema, req.get('idempotency-key'));
    const body = parse(PlaceOrderRequestSchema, req.body); // strict: customerId cannot be smuggled in
    const out = await placeOrder(
      ordersCtx,
      { principalId: p.userId, idempotencyKey: key, storeId: body.storeId, lines: body.lines },
      actor(req),
    );
    res.setHeader('Idempotent-Replayed', String(out.replayed));
    if (out.statusCode === 201 && out.orderId) res.setHeader('Location', `/api/v1/orders/${out.orderId}`);
    res.status(out.statusCode).json(out.body);
  });
  r.get('/orders', permit('orders:read'), async (req, res) => {
    const q = parse(ListOrdersQuerySchema, req.query);
    res.json(await listOrdersForPrincipal(pools.orders, principalOf(req), q));
  });
  r.get('/orders/:id', permit('orders:read'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    const order = await getOrderForPrincipal(pools.orders, principalOf(req), id);
    if (!order) throw new AppError('NOT_FOUND', 'Order not found');
    res.json({ order });
  });
  r.post('/orders/:id/cancel', permit('orders:cancel'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    const body = parse(CancelOrderRequestSchema, req.body ?? {});
    // Object-level check: the order must be visible in the caller's scope (own order / own store / admin).
    if (!(await getOrderForPrincipal(pools.orders, principalOf(req), id)))
      throw new AppError('NOT_FOUND', 'Order not found');
    res.json(await cancelOrder(ordersCtx, { orderId: id, reason: body.reason }, actor(req)));
  });

  // ---- inventory (store-scoped staff resources) ---------------------------------------------------------------
  r.get('/stores/:storeId/inventory/:sku', permit('inventory:read'), async (req, res) => {
    const { storeId, sku } = parse(StoreSkuParamsSchema, req.params);
    assertStoreAccess(principalOf(req), storeId);
    const balance = await getBalance(pools.orders, storeId, sku);
    if (!balance) throw new AppError('NOT_FOUND', 'No inventory for this SKU in this store');
    res.json({ balance });
  });
  r.post('/stores/:storeId/inventory/:sku/restocks', permit('inventory:write'), async (req, res) => {
    const { storeId, sku } = parse(StoreSkuParamsSchema, req.params);
    assertStoreAccess(principalOf(req), storeId);
    const body = parse(RestockRequestSchema, req.body);
    const out = await restock(
      ordersCtx,
      { storeId, sku, qty: body.qty, sourceId: body.sourceId },
      actor(req),
    );
    res.status(out.applied ? 201 : 200).json(out);
  });
  r.post('/stores/:storeId/inventory/:sku/adjustments', permit('inventory:write'), async (req, res) => {
    const { storeId, sku } = parse(StoreSkuParamsSchema, req.params);
    assertStoreAccess(principalOf(req), storeId);
    const body = parse(AdjustRequestSchema, req.body);
    const out = await adjustStock(
      ordersCtx,
      { storeId, sku, delta: body.delta, sourceId: body.sourceId, reason: body.reason },
      actor(req),
    );
    res.status(out.applied ? 201 : 200).json(out);
  });

  return r;
}
