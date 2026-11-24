import { z } from 'zod';

/**
 * External input schemas. All objects are `.strict()`: unknown keys are rejected, which closes the
 * mass-assignment class of bugs (e.g. smuggling `role` or `customerId` into a request body).
 */
export const SkuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,63}$/, 'invalid SKU format');
export const StoreIdSchema = z.number().int().positive().max(1_000_000);

export const PlaceOrderRequestSchema = z
  .object({
    storeId: StoreIdSchema,
    lines: z
      .array(z.object({ sku: SkuSchema, qty: z.number().int().positive().max(1000) }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequestSchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, 'idempotency key may contain only [A-Za-z0-9_-:.]');

export const UuidParamSchema = z.object({ id: z.uuid() }).strict();

// ---- Phase 3: identity, admin, orders, inventory -------------------------------------------------------------
const Email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
// Length/content policy is enforced by the identity domain; the cap here bounds hashing cost.
const Password = z.string().min(1).max(1024);
const DisplayName = z.string().trim().min(1).max(100);
const SourceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/);
export const RoleSchema = z.enum(['customer', 'picker', 'supervisor', 'admin']);

export const RegisterRequestSchema = z
  .object({ email: Email, password: Password, displayName: DisplayName })
  .strict();
export const LoginRequestSchema = z.object({ email: Email, password: Password }).strict();
export const UpdateMeRequestSchema = z.object({ displayName: DisplayName }).strict();
export const AdminCreateUserSchema = z
  .object({
    email: Email,
    password: Password,
    displayName: DisplayName,
    role: RoleSchema,
    storeId: StoreIdSchema.nullable(),
  })
  .strict();
export const AdminChangeRoleSchema = z
  .object({ role: RoleSchema, storeId: StoreIdSchema.nullable() })
  .strict();

export const CancelOrderRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(200).default('customer_request') })
  .strict();
export const ListOrdersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export const StoreSkuParamsSchema = z
  .object({ storeId: z.coerce.number().int().positive().max(1_000_000), sku: SkuSchema })
  .strict();
export const RestockRequestSchema = z
  .object({ qty: z.number().int().positive().max(100_000), sourceId: SourceId })
  .strict();
export const AdjustRequestSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((d) => d !== 0, 'delta must be non-zero'),
    reason: z.string().trim().min(1).max(200),
    sourceId: SourceId,
  })
  .strict();

// ---- dead letters (admin, /internal) ---------------------------------------------------------------------------
export const DeadLetterListQuerySchema = z
  .object({
    status: z.enum(['dead', 'replay_requested', 'replayed', 'discarded']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    beforeId: z.coerce.number().int().positive().optional(),
  })
  .strict();
export const DeadLetterIdParamSchema = z
  .object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();
export const DiscardDeadLetterSchema = z.object({ note: z.string().trim().min(3).max(500) }).strict();

// ---- Phase 4: picking, offline sync, catalog -------------------------------------------------------------------
export const TaskListQuerySchema = z
  .object({
    scope: z.enum(['available', 'mine', 'active', 'all']).default('available'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const PickConfirmOp = z
  .object({
    opId: z.uuid(),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('pick.confirm'),
    taskId: z.uuid(),
    payload: z
      .object({ orderLineId: z.uuid(), scannedSku: SkuSchema, pickedQty: z.number().int().min(0).max(1000) })
      .strict(),
    clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const TaskCompleteOp = z
  .object({
    opId: z.uuid(),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('task.complete'),
    taskId: z.uuid(),
    payload: z.object({}).strict(),
    clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const SyncRequestSchema = z
  .object({
    deviceId: z.uuid(),
    ops: z
      .array(z.discriminatedUnion('type', [PickConfirmOp, TaskCompleteOp]))
      .min(1)
      .max(100),
  })
  .strict();
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const RejectionListQuerySchema = z
  .object({
    status: z.enum(['open', 'resolved', 'all']).default('open'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export const DeviceOpParamsSchema = z.object({ deviceId: z.uuid(), opId: z.uuid() }).strict();
export const ResolveRejectionSchema = z
  .object({
    resolution: z.enum(['acknowledged', 'recount_requested']),
    note: z.string().trim().min(3).max(500),
  })
  .strict();
export const StoreIdParamSchema = z
  .object({ storeId: z.coerce.number().int().positive().max(1_000_000) })
  .strict();
export const ListUsersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    role: z.enum(['customer', 'picker', 'supervisor', 'admin']).optional(),
  })
  .strict();

export const CatalogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
