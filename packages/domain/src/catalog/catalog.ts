import type { PgPool } from '@aisleforge/database';

/**
 * Read models for the UIs. `available` here is DISPLAY-ONLY (it may be stale by the time an order is placed);
 * whether an order can reserve stock is decided exclusively by the guarded UPDATE in placeOrder (ADR-002).
 */
export interface StoreView {
  id: number;
  code: string;
  name: string;
  hasLayout: boolean;
}

export async function listStores(pool: PgPool): Promise<StoreView[]> {
  const { rows } = await pool.query<{ id: number; code: string; name: string; has_layout: boolean }>(
    `SELECT s.id, s.code, s.name, EXISTS (SELECT 1 FROM store_layouts l WHERE l.store_id = s.id) AS has_layout
       FROM stores s ORDER BY s.id`,
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, hasLayout: r.has_layout }));
}

export interface CatalogItem {
  sku: string;
  name: string;
  zone: string;
  unitPriceCents: number;
  available: number;
}

export async function storeCatalog(
  pool: PgPool,
  storeId: number,
  page: { limit: number; offset: number } = { limit: 500, offset: 0 },
): Promise<CatalogItem[]> {
  const { rows } = await pool.query<{
    sku: string;
    name: string;
    zone: string;
    unit_price_cents: number;
    available: number;
  }>(
    `SELECT p.sku, p.name, p.temperature_zone AS zone, p.unit_price_cents, (b.on_hand - b.reserved) AS available
       FROM inventory_balances b JOIN products p ON p.sku = b.sku
      WHERE b.store_id = $1 ORDER BY p.name, p.sku LIMIT $2 OFFSET $3`,
    [storeId, page.limit, page.offset],
  );
  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    zone: r.zone,
    unitPriceCents: r.unit_price_cents,
    available: r.available,
  }));
}

export interface InventoryRow {
  sku: string;
  name: string;
  zone: string;
  onHand: number;
  reserved: number;
  available: number;
  version: number;
  updatedAt: string;
  location: { aisle: number; pos: number } | null;
}

export async function storeInventory(pool: PgPool, storeId: number): Promise<InventoryRow[]> {
  const { rows } = await pool.query<{
    sku: string;
    name: string;
    zone: string;
    on_hand: number;
    reserved: number;
    version: number;
    updated_at: Date;
    aisle: number | null;
    pos: number | null;
  }>(
    `SELECT b.sku, p.name, p.temperature_zone AS zone, b.on_hand, b.reserved, b.version, b.updated_at, s.aisle, s.pos
       FROM inventory_balances b JOIN products p ON p.sku = b.sku
       LEFT JOIN sku_locations s ON s.store_id = b.store_id AND s.sku = b.sku
      WHERE b.store_id = $1 ORDER BY b.sku`,
    [storeId],
  );
  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    zone: r.zone,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.on_hand - r.reserved,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
    location: r.aisle === null || r.pos === null ? null : { aisle: r.aisle, pos: r.pos },
  }));
}

export interface UserListItem {
  id: string;
  email: string;
  displayName: string;
  role: string;
  storeId: number | null;
  disabled: boolean;
  createdAt: string;
}

export async function listUsers(
  pool: PgPool,
  q: { limit: number; role?: string | undefined },
): Promise<UserListItem[]> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    role: string;
    store_id: number | null;
    disabled_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, email, display_name, role, store_id, disabled_at, created_at FROM users
      WHERE ($2::user_role IS NULL OR role = $2::user_role) ORDER BY created_at DESC LIMIT $1`,
    [q.limit, q.role ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    storeId: r.store_id,
    disabled: r.disabled_at !== null,
    createdAt: r.created_at.toISOString(),
  }));
}
