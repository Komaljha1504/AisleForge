import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeLines, placeOrderRequestHash } from '@aisleforge/domain';
import { AppError, canonicalJson } from '@aisleforge/shared';

const limits = { maxLines: 50, maxQty: 1000 };

describe('normalizeLines', () => {
  it('merges duplicate SKUs, keeps first-appearance line numbers, sorts by SKU byte order', () => {
    const out = normalizeLines(
      [
        { sku: 'SKU-B', qty: 1 },
        { sku: 'SKU-A', qty: 2 },
        { sku: 'SKU-B', qty: 3 },
      ],
      limits,
    );
    expect(out).toEqual([
      { sku: 'SKU-A', qty: 2, lineNo: 2 },
      { sku: 'SKU-B', qty: 4, lineNo: 1 },
    ]);
  });

  it('uses byte order, not locale order, so app order matches ORDER BY ... COLLATE "C"', () => {
    const out = normalizeLines(
      [
        { sku: 'SKU1', qty: 1 },
        { sku: 'SKU-10', qty: 1 },
        { sku: 'A', qty: 1 },
      ],
      limits,
    );
    expect(out.map((l) => l.sku)).toEqual(['A', 'SKU-10', 'SKU1']); // '-' (0x2D) < '1' (0x31)
  });

  it.each([
    [[], 'at least one line'],
    [[{ sku: 'X', qty: 0 }], 'Invalid qty'],
    [[{ sku: 'X', qty: 1.5 }], 'Invalid qty'],
    [
      [
        { sku: 'X', qty: 600 },
        { sku: 'X', qty: 600 },
      ],
      'exceeds',
    ],
  ])('rejects invalid input %#', (lines, msg) => {
    expect(() => normalizeLines(lines, limits)).toThrowError(msg);
  });

  it('rejects too many distinct SKUs', () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ sku: `S${i}`, qty: 1 }));
    expect(() => normalizeLines(lines, limits)).toThrow(AppError);
  });
});

describe('placeOrderRequestHash', () => {
  it('is invariant to line order and duplicate-SKU splitting (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({ sku: fc.constantFrom('A', 'B', 'C', 'D', 'E'), qty: fc.integer({ min: 1, max: 9 }) }),
          {
            selector: (l) => l.sku,
            minLength: 1,
          },
        ),
        fc.integer({ min: 0, max: 1000 }),
        (lines, seed) => {
          const shuffled = [...lines].sort(() =>
            (seed = (seed * 9301 + 49297) % 233280) / 233280 < 0.5 ? -1 : 1,
          );
          const split = shuffled.flatMap((l) =>
            l.qty > 1
              ? [
                  { sku: l.sku, qty: 1 },
                  { sku: l.sku, qty: l.qty - 1 },
                ]
              : [l],
          );
          const h1 = placeOrderRequestHash(1, normalizeLines(lines, limits));
          const h2 = placeOrderRequestHash(1, normalizeLines(split, limits));
          return h1 === h2;
        },
      ),
      { seed: 42, numRuns: 200 },
    );
  });

  it('differs when store or quantity differs', () => {
    const l = normalizeLines([{ sku: 'A', qty: 1 }], limits);
    expect(placeOrderRequestHash(1, l)).not.toEqual(placeOrderRequestHash(2, l));
    expect(placeOrderRequestHash(1, l)).not.toEqual(
      placeOrderRequestHash(1, normalizeLines([{ sku: 'A', qty: 2 }], limits)),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });
});
