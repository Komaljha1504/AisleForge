import { AppError } from '@aisleforge/shared';

export const ROLES = ['customer', 'picker', 'supervisor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Authenticated identity, derived ONLY from a verified access token. Never from a request body. */
export interface Principal {
  userId: string;
  role: Role;
  /** Store the staff member belongs to; null for customers and (global) admins. */
  storeId: number | null;
  sessionId: string;
}

/**
 * Function-level authorization (OWASP API5). Object-level/store-level checks are separate (assertStoreAccess,
 * scoped queries) because a permission alone never grants access to another store's data.
 */
export const PERMISSIONS = {
  'orders:place': ['customer'],
  'orders:read': ['customer', 'picker', 'supervisor', 'admin'],
  'orders:cancel': ['customer', 'supervisor', 'admin'],
  'inventory:read': ['picker', 'supervisor', 'admin'],
  'inventory:write': ['supervisor', 'admin'],
  'users:manage': ['admin'],
  'internal:status': ['admin'],
  'catalog:read': ['customer', 'picker', 'supervisor', 'admin'],
  'tasks:read': ['picker', 'supervisor', 'admin'],
  'tasks:pick': ['picker', 'supervisor'],
  'sync:write': ['picker', 'supervisor'],
  'rejections:review': ['supervisor', 'admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (p: Principal, perm: Permission): boolean =>
  (PERMISSIONS[perm] as readonly Role[]).includes(p.role);

export function requirePermission(p: Principal, perm: Permission): void {
  if (!can(p, perm)) throw new AppError('FORBIDDEN', 'You do not have permission for this action');
}

/** Store isolation for store-addressed staff resources: admins are global, staff only see their own store. */
export function assertStoreAccess(p: Principal, storeId: number): void {
  if (p.role === 'admin') return;
  if ((p.role === 'picker' || p.role === 'supervisor') && p.storeId === storeId) return;
  throw new AppError('FORBIDDEN', 'You do not have access to this store');
}

/** SQL fragment parameters for row-level scoping of orders (used by scoped queries). */
export function orderScope(p: Principal): { role: Role; userId: string; storeId: number | null } {
  return { role: p.role, userId: p.userId, storeId: p.storeId };
}
