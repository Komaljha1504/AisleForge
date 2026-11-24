import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Spinner,
  statusTone,
  when,
} from '../../components/ui';
import { api, describeError } from '../../lib/api';
import type { OrderDetail, OrderSummary } from '../../lib/types';

export function OrdersPage() {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [open, setOpen] = useState<OrderDetail | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders((await api<{ items: OrderSummary[] }>('/api/v1/orders?limit=50')).items);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const show = async (id: string) => {
    try {
      setOpen((await api<{ order: OrderDetail }>(`/api/v1/orders/${id}`)).order);
    } catch (e) {
      setError(describeError(e));
    }
  };
  const cancel = async () => {
    if (!cancelId) return;
    setBusy(true);
    try {
      await api(`/api/v1/orders/${cancelId}/cancel`, {
        method: 'POST',
        body: { reason: 'customer_request' },
      });
      setCancelId(null);
      await load();
      if (open?.id === cancelId) await show(cancelId);
    } catch (e) {
      setError(describeError(e));
      setCancelId(null);
    } finally {
      setBusy(false);
    }
  };

  if (!orders) return error ? <Alert>{error}</Alert> : <Spinner />;
  return (
    <div className="space-y-5">
      <PageHeader title="My orders" subtitle="Updated every few seconds while this page is open." />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Orders">
          {orders.length === 0 ? (
            <EmptyState title="No orders yet">Place one from the Shop.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="orders">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 py-3">
                  <button type="button" className="text-left" onClick={() => void show(o.id)}>
                    <p className="font-mono text-sm font-medium">{o.id.slice(-8)}</p>
                    <p className="text-xs text-slate-500">
                      store {o.storeId} · {when(o.createdAt)}
                    </p>
                  </button>
                  <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={open ? `Order ${open.id.slice(-8)}` : 'Details'}>
          {!open ? (
            <p className="text-sm text-slate-600">Select an order to see its lines.</p>
          ) : (
            <div className="space-y-3">
              <p>
                <Badge tone={statusTone(open.status)}>{open.status}</Badge>
              </p>
              <ul className="space-y-1 text-sm">
                {open.lines.map((l) => (
                  <li key={l.lineNo} className="flex justify-between">
                    <span className="font-mono">{l.sku}</span>
                    <span>
                      {l.qty} ordered{l.pickedQty ? ` · ${l.pickedQty} picked` : ''}
                      {l.shortQty ? ` · ${l.shortQty} unavailable` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {['reserved', 'picking'].includes(open.status) && (
                <Button variant="danger" onClick={() => setCancelId(open.id)}>
                  Cancel order
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={cancelId !== null}
        title="Cancel this order?"
        confirmLabel="Cancel order"
        busy={busy}
        onCancel={() => setCancelId(null)}
        onConfirm={() => void cancel()}
      >
        The reserved stock is released immediately. This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
