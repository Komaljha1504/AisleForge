import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, money } from '../../components/ui';
import { api, ApiError, describeError } from '../../lib/api';
import type { CatalogItem, Store } from '../../lib/types';

/**
 * Availability shown here is display-only; the order is accepted or refused by PostgreSQL at placement time.
 * One Idempotency-Key per checkout attempt, reused on retry: a double click or a network retry cannot create two orders.
 */
export function ShopPage() {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutKey, setCheckoutKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api<{ stores: Store[] }>('/api/v1/stores')
      .then((r) => {
        setStores(r.stores);
        if (r.stores[0]) setStoreId(r.stores[0].id);
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, []);
  useEffect(() => {
    if (storeId === null) return;
    setItems(null);
    setCart({});
    api<{ items: CatalogItem[] }>(`/api/v1/stores/${storeId}/catalog`)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(describeError(e)));
  }, [storeId]);

  const lines = useMemo(() => Object.entries(cart).filter(([, q]) => q > 0), [cart]);
  const total = lines.reduce(
    (s, [sku, q]) => s + (items?.find((i) => i.sku === sku)?.unitPriceCents ?? 0) * q,
    0,
  );

  const checkout = async () => {
    if (storeId === null || lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ orderId: string }>('/api/v1/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': `web-${checkoutKey}` },
        body: { storeId, lines: lines.map(([sku, qty]) => ({ sku, qty })) },
      });
      setPlaced(r.orderId);
      setCart({});
      setCheckoutKey(crypto.randomUUID());
      const fresh = await api<{ items: CatalogItem[] }>(`/api/v1/stores/${storeId}/catalog`);
      setItems(fresh.items);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') {
        setError(
          'Some items are no longer available in that quantity. Your cart was not charged; adjust and retry.',
        );
        setCheckoutKey(crypto.randomUUID()); // the cart will change, so this is a new attempt
      } else setError(describeError(e)); // network error etc.: keep the key so a retry cannot duplicate the order
    } finally {
      setBusy(false);
    }
  };

  if (!stores) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Shop"
        subtitle="Choose a store, add items, place your order."
        actions={
          <select
            aria-label="Store"
            className="field w-56"
            value={storeId ?? ''}
            onChange={(e) => setStoreId(Number(e.target.value))}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        }
      />
      {placed && (
        <Alert tone="green" title="Order placed">
          Your stock is reserved.{' '}
          <Link className="font-semibold underline" to="/orders">
            Track it in My orders
          </Link>
          .
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <Card title="Products">
          {!items ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState title="This store has no products yet" />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="catalog">
              {items.map((i) => (
                <li key={i.sku} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{i.name}</p>
                      <p className="font-mono text-xs text-slate-500">{i.sku}</p>
                    </div>
                    <p className="font-semibold">{money(i.unitPriceCents)}</p>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="flex gap-1">
                      {i.zone !== 'ambient' && <Badge tone="blue">{i.zone}</Badge>}
                      {i.available > 0 ? (
                        <Badge tone="green">{i.available} available</Badge>
                      ) : (
                        <Badge tone="red">out of stock</Badge>
                      )}
                    </span>
                    <span className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        aria-label={`Remove one ${i.name}`}
                        disabled={!cart[i.sku]}
                        onClick={() => setCart({ ...cart, [i.sku]: Math.max(0, (cart[i.sku] ?? 0) - 1) })}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{cart[i.sku] ?? 0}</span>
                      <Button
                        variant="secondary"
                        aria-label={`Add one ${i.name}`}
                        disabled={(cart[i.sku] ?? 0) >= i.available}
                        onClick={() => setCart({ ...cart, [i.sku]: (cart[i.sku] ?? 0) + 1 })}
                      >
                        +
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Your cart">
          {lines.length === 0 ? (
            <p className="text-sm text-slate-600">Your cart is empty.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {lines.map(([sku, q]) => (
                <li key={sku} className="flex justify-between">
                  <span>
                    {items?.find((i) => i.sku === sku)?.name ?? sku} × {q}
                  </span>
                </li>
              ))}
              <li className="flex justify-between border-t border-slate-100 pt-2 font-semibold">
                <span>Total</span>
                <span>{money(total)}</span>
              </li>
            </ul>
          )}
          <Button
            className="mt-4 w-full"
            disabled={lines.length === 0}
            busy={busy}
            onClick={() => void checkout()}
          >
            Place order
          </Button>
        </Card>
      </div>
    </div>
  );
}
