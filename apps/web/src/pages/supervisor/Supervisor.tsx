import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
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
import type { TaskView } from '../../lib/types';
import { reasonText } from '../picker/Pick';

export function SupervisorOverviewPage() {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [release, setRelease] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setTasks((await api<{ tasks: TaskView[] }>('/api/v1/pick-tasks?scope=active&limit=200')).tasks);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  if (!tasks) return error ? <Alert>{error}</Alert> : <Spinner />;
  const open = tasks.filter((t) => t.status === 'open');
  const claimed = tasks.filter((t) => t.status === 'claimed');
  const attention = tasks.filter(
    (t) => t.routeStatus === 'infeasible' || (t.leaseExpiresAt && new Date(t.leaseExpiresAt) < new Date()),
  );
  return (
    <div className="space-y-5">
      <PageHeader title="Store overview" subtitle="Active pick tasks, refreshed every 10 seconds." />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-5 sm:grid-cols-3">
        <Card title="Waiting">
          <p className="text-3xl font-bold">{open.length}</p>
        </Card>
        <Card title="Being picked">
          <p className="text-3xl font-bold">{claimed.length}</p>
        </Card>
        <Card title="Need attention">
          <p className="text-3xl font-bold text-amber-700">{attention.length}</p>
        </Card>
      </div>
      <Card title="Active tasks">
        {tasks.length === 0 ? (
          <EmptyState title="No active tasks" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">Order</th>
                  <th>Status</th>
                  <th>Route</th>
                  <th>Picker</th>
                  <th>Lease until</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td className="py-2 font-mono">{t.orderId.slice(-8)}</td>
                    <td>
                      <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                    </td>
                    <td>
                      <Badge tone={statusTone(t.routeStatus)}>{t.routeStatus}</Badge>
                    </td>
                    <td>{t.assignedToName ?? '—'}</td>
                    <td>{when(t.leaseExpiresAt)}</td>
                    <td className="text-right">
                      {t.status === 'claimed' && (
                        <Button variant="secondary" onClick={() => setRelease(t)}>
                          Release
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={release !== null}
        title="Release this task?"
        confirmLabel="Release"
        onCancel={() => setRelease(null)}
        onConfirm={async () => {
          const t = release;
          setRelease(null);
          try {
            await api(`/api/v1/pick-tasks/${t!.id}/release`, { method: 'POST' });
            await load();
          } catch (e) {
            setError(describeError(e));
          }
        }}
      >
        {release?.assignedToName} loses the task. Picks they recorded offline and have not synchronized yet
        will be rejected and appear in the rejected-operations queue.
      </ConfirmDialog>
    </div>
  );
}

interface Rejection {
  deviceId: string;
  opId: string;
  userName: string;
  type: string;
  orderId: string | null;
  payload: Record<string, unknown>;
  reason: string;
  receivedAt: string;
  reviewStatus: string;
  reviewNote: string | null;
}

export function RejectionsPage() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [items, setItems] = useState<Rejection[] | null>(null);
  const [resolving, setResolving] = useState<Rejection | null>(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState<'acknowledged' | 'recount_requested'>('acknowledged');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(
        (await api<{ rejections: Rejection[] }>(`/api/v1/sync/rejections?status=${status}`)).rejections,
      );
    } catch (e) {
      setError(describeError(e));
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!resolving) return;
    try {
      await api(`/api/v1/sync/rejections/${resolving.deviceId}/${resolving.opId}/resolve`, {
        method: 'POST',
        body: { resolution, note },
      });
      setResolving(null);
      setNote('');
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Rejected operations"
        subtitle="Offline actions the server could not apply. Nothing is lost: decide what happens to each one."
        actions={
          <select
            aria-label="Filter"
            className="field w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'open' | 'resolved')}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        }
      />
      {error && <Alert>{error}</Alert>}
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title={status === 'open' ? 'Nothing to review' : 'No resolved items yet'} />
      ) : (
        <ul className="space-y-3" data-testid="rejections">
          {items.map((r) => (
            <li key={r.opId} className="card flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="text-sm">
                <p className="font-medium">
                  {r.type === 'pick.confirm'
                    ? `Pick ${String(r.payload.scannedSku)} × ${String(r.payload.pickedQty)}`
                    : 'Task completion'}{' '}
                  by {r.userName}
                </p>
                <p className="text-red-700">{reasonText(r.reason)}</p>
                <p className="text-xs text-slate-500">
                  order {r.orderId?.slice(-8) ?? '—'} · received {when(r.receivedAt)}
                </p>
                {r.reviewNote && <p className="mt-1 text-slate-700">Note: {r.reviewNote}</p>}
              </div>
              {r.reviewStatus === 'open' ? (
                <Button variant="secondary" onClick={() => setResolving(r)}>
                  Review
                </Button>
              ) : (
                <Badge tone="green">{r.reviewStatus.replace('_', ' ')}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {resolving && (
        <Card title="Resolve">
          <form onSubmit={submit} className="space-y-3">
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="label">Outcome</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={resolution === 'acknowledged'}
                  onChange={() => setResolution('acknowledged')}
                />{' '}
                Acknowledge
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={resolution === 'recount_requested'}
                  onChange={() => setResolution('recount_requested')}
                />{' '}
                Request a recount
              </label>
            </fieldset>
            <div>
              <label className="label" htmlFor="note">
                Note (required)
              </label>
              <textarea
                id="note"
                className="field"
                required
                minLength={3}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setResolving(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

interface InventoryRow {
  sku: string;
  name: string;
  zone: string;
  onHand: number;
  reserved: number;
  available: number;
  location: { aisle: number; pos: number } | null;
}

export function InventoryPage() {
  const { user } = useAuth();
  const [storeId, setStoreId] = useState<number>(user?.storeId ?? 1);
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [edit, setEdit] = useState<{ sku: string; mode: 'restock' | 'adjust' } | null>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows((await api<{ items: InventoryRow[] }>(`/api/v1/stores/${storeId}/inventory`)).items);
    } catch (e) {
      setError(describeError(e));
    }
  }, [storeId]);
  useEffect(() => {
    void load();
  }, [load]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError(null);
    const sourceId = `web-${crypto.randomUUID()}`; // idempotent: a retry of this submission cannot double-apply
    try {
      if (edit.mode === 'restock')
        await api(`/api/v1/stores/${storeId}/inventory/${edit.sku}/restocks`, {
          method: 'POST',
          body: { qty, sourceId },
        });
      else
        await api(`/api/v1/stores/${storeId}/inventory/${edit.sku}/adjustments`, {
          method: 'POST',
          body: { delta: qty, reason, sourceId },
        });
      setEdit(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        subtitle="Counts are authoritative (PostgreSQL); every change is recorded in the ledger."
        actions={
          user?.role === 'admin' ? (
            <input
              aria-label="Store id"
              type="number"
              min={1}
              className="field w-28"
              value={storeId}
              onChange={(e) => setStoreId(Number(e.target.value))}
            />
          ) : undefined
        }
      />
      {error && <Alert>{error}</Alert>}
      {edit && (
        <Card title={`${edit.mode === 'restock' ? 'Restock' : 'Adjust'} ${edit.sku}`}>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="inv-qty">
                {edit.mode === 'restock' ? 'Units received' : 'Change (negative to remove)'}
              </label>
              <input
                id="inv-qty"
                type="number"
                className="field w-36"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                required
              />
            </div>
            {edit.mode === 'adjust' && (
              <div className="min-w-[14rem] flex-1">
                <label className="label" htmlFor="inv-reason">
                  Reason
                </label>
                <input
                  id="inv-reason"
                  className="field"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  maxLength={200}
                />
              </div>
            )}
            <Button type="submit" busy={busy}>
              Apply
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </form>
        </Card>
      )}
      <Card>
        {!rows ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No stock in this store" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">SKU</th>
                  <th>Product</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Reserved</th>
                  <th className="text-right">Available</th>
                  <th>Bin</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.sku}>
                    <td className="py-2 font-mono">{r.sku}</td>
                    <td>
                      {r.name} {r.zone !== 'ambient' && <Badge tone="blue">{r.zone}</Badge>}
                    </td>
                    <td className="text-right tabular-nums">{r.onHand}</td>
                    <td className="text-right tabular-nums">{r.reserved}</td>
                    <td className="text-right tabular-nums">{r.available}</td>
                    <td>{r.location ? `A${r.location.aisle} · ${r.location.pos} m` : '—'}</td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEdit({ sku: r.sku, mode: 'restock' });
                          setQty(10);
                        }}
                      >
                        Restock
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEdit({ sku: r.sku, mode: 'adjust' });
                          setQty(-1);
                          setReason('');
                        }}
                      >
                        Adjust
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
