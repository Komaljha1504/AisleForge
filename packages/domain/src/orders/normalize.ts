import { AppError, canonicalJson, sha256Hex } from '@aisleforge/shared';

export interface RequestedLine {
  sku: string;
  qty: number;
}

export interface NormalizedLine extends RequestedLine {
  lineNo: number;
}

/**
 * Merges duplicate SKUs (summing quantities), validates bounds, and keeps first-appearance line numbers.
 * The returned array is sorted by SKU (byte order) — the canonical lock order (ADR-002).
 */
export function normalizeLines(
  lines: RequestedLine[],
  limits: { maxLines: number; maxQty: number },
): NormalizedLine[] {
  if (lines.length === 0) throw new AppError('VALIDATION_FAILED', 'An order needs at least one line');
  const merged = new Map<string, NormalizedLine>();
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0)
      throw new AppError('VALIDATION_FAILED', `Invalid qty for ${l.sku}`);
    const existing = merged.get(l.sku);
    if (existing) existing.qty += l.qty;
    else merged.set(l.sku, { sku: l.sku, qty: l.qty, lineNo: merged.size + 1 });
  }
  if (merged.size > limits.maxLines)
    throw new AppError('VALIDATION_FAILED', `At most ${limits.maxLines} distinct SKUs per order`);
  for (const l of merged.values()) {
    if (l.qty > limits.maxQty)
      throw new AppError('VALIDATION_FAILED', `qty for ${l.sku} exceeds ${limits.maxQty}`);
  }
  return [...merged.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

/** Hash of the *semantic* request: line order and duplicate-SKU splitting do not change it. */
export function placeOrderRequestHash(storeId: number, lines: NormalizedLine[]): string {
  return sha256Hex(
    canonicalJson({ op: 'orders.place', storeId, lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })) }),
  );
}
