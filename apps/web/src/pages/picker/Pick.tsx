import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useSyncState } from '../../components/Layout';
import { RouteMap } from '../../components/RouteMap';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  PageHeader,
  Spinner,
  statusTone,
  when,
} from '../../components/ui';
import { api, ApiError, describeError, OfflineError } from '../../lib/api';
import type { CachedTask, TaskLine, TaskView } from '../../lib/types';
import { cacheTask, cachedTask, recordOp, StorageFullError } from '../../offline/db';
import { refreshCounts, syncNow } from '../../offline/sync';

type LineState =
  | { kind: 'todo' }
  | { kind: 'pending'; qty: number }
  | { kind: 'done'; qty: number; short: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

const REASONS: Record<string, string> = {
  wrong_item_scanned: 'The scanned item did not match this line.',
  task_not_assigned_to_you: 'This task was reassigned to someone else before your pick reached the server.',
  task_cancelled: 'The order was cancelled.',
  line_already_picked: 'This line had already been picked.',
  reservation_expired: 'The stock reservation expired before the pick reached the server.',
  reservation_released: 'The stock was released (order cancelled or task released).',
  lines_outstanding: 'Some lines were not picked yet when completion reached the server.',
  sequence_regression: 'This device sent operations out of order; ask a supervisor.',
};
export const reasonText = (r: string | undefined) => (r ? (REASONS[r] ?? r.replace(/_/g, ' ')) : 'Rejected');

function lineState(line: TaskLine, c: CachedTask): LineState {
  const local = c.local[line.orderLineId];
  if (line.reservationStatus === 'picked') return { kind: 'done', qty: line.pickedQty, short: line.shortQty };
  if (local?.status === 'rejected') return { kind: 'rejected', reason: local.reason ?? 'rejected' };
  if (local?.status === 'pending') return { kind: 'pending', qty: local.pickedQty };
  if (local?.status === 'applied')
    return { kind: 'done', qty: local.pickedQty, short: line.qty - local.pickedQty };
  if (line.reservationStatus && line.reservationStatus !== 'active')
    return { kind: 'unavailable', reason: `reservation_${line.reservationStatus}` };
  return { kind: 'todo' };
}

export function PickPage() {
  const { id } = useParams();
  const { user, offlineSession } = useAuth();
  const sync = useSyncState();
  const online = sync.online && !offlineSession;
  const [c, setC] = useState<CachedTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scan, setScan] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [confirmShort, setConfirmShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!id || !user) return;
    if (online) {
      try {
        const { task } = await api<{ task: TaskView }>(`/api/v1/pick-tasks/${id}`);
        await cacheTask(user.id, task);
      } catch (e) {
        if (!(e instanceof OfflineError)) setError(describeError(e));
      }
    }
    const cached = await cachedTask(id);
    setC(cached && cached.userId === user.id ? cached : null);
  }, [id, user, online]);

  useEffect(() => {
    void reload();
  }, [reload, sync.pending, sync.lastSyncAt]);

  const lines = useMemo(() => {
    if (!c?.task.lines) return [];
    const order = new Map(c.task.route.stops.map((s) => [s.orderLineId, s.sequence]));
    return [...c.task.lines].sort(
      (a, b) => (order.get(a.orderLineId) ?? 999 + a.lineNo) - (order.get(b.orderLineId) ?? 999 + b.lineNo),
    );
  }, [c]);

  if (!c) return <Spinner />;
  const task = c.task;
  const states = new Map(lines.map((l) => [l.orderLineId, lineState(l, c)]));
  const done = new Set(
    lines
      .filter((l) => ['done', 'pending'].includes(states.get(l.orderLineId)!.kind))
      .map((l) => l.orderLineId),
  );
  const resolved = lines.every((l) => states.get(l.orderLineId)!.kind !== 'todo');
  const mineNow = task.assignedTo === user?.id;
  const activeLine = lines.find((l) => l.orderLineId === active) ?? null;
  const completion = task.status === 'completed' ? 'completed' : c.complete?.status;

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const sku = scan.trim().toUpperCase();
    const match = lines.find((l) => l.sku === sku && states.get(l.orderLineId)!.kind === 'todo');
    if (!match) {
      setError(
        lines.some((l) => l.sku === sku)
          ? `${sku} is already recorded for this task.`
          : `${sku} is not part of this task. Check the bin label and scan again.`,
      );
      setScan('');
      return;
    }
    setActive(match.orderLineId);
    setQty(match.qty);
    setScan('');
  };

  const record = async (line: TaskLine, pickedQty: number) => {
    setBusy(true);
    setError(null);
    try {
      await recordOp({
        userId: user!.id,
        type: 'pick.confirm',
        taskId: task.id,
        payload: { orderLineId: line.orderLineId, scannedSku: line.sku, pickedQty },
      });
      setNotice(
        online
          ? `${line.sku}: saved, sending to the server…`
          : `${line.sku}: saved on this device. It will be sent when you are back online.`,
      );
      setActive(null);
      await refreshCounts();
      await reload();
      if (online) void syncNow('after-pick');
      scanRef.current?.focus();
    } catch (e) {
      setError(e instanceof StorageFullError ? e.message : `Not recorded: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      await recordOp({ userId: user!.id, type: 'task.complete', taskId: task.id, payload: {} });
      await refreshCounts();
      await reload();
      if (online) void syncNow('after-complete');
    } catch (e) {
      setError(e instanceof StorageFullError ? e.message : `Not recorded: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const renew = async () => {
    try {
      const { task: t } = await api<{ task: TaskView }>(`/api/v1/pick-tasks/${task.id}/claim`, {
        method: 'POST',
      });
      await cacheTask(user!.id, t);
      await reload();
      setNotice('Lease renewed.');
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'This task now belongs to someone else.'
          : describeError(e),
      );
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Order ${task.orderId.slice(-8)}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(task.status)}>{task.status}</Badge>
            <Badge tone={statusTone(task.routeStatus)}>route {task.routeStatus}</Badge>
            {task.leaseExpiresAt && <span>lease until {when(task.leaseExpiresAt)}</span>}
          </span>
        }
        actions={
          <>
            <Link
              to="/tasks"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold"
            >
              Back
            </Link>
            {task.status === 'claimed' && mineNow && (
              <Button variant="secondary" disabled={!online} onClick={() => void renew()}>
                Renew lease
              </Button>
            )}
          </>
        }
      />
      {!online && (
        <Alert tone="amber" title="Offline">
          Keep picking: every pick is saved on this device and sent automatically when the connection returns.
        </Alert>
      )}
      {!mineNow && task.status === 'claimed' && (
        <Alert>This task is now assigned to {task.assignedToName ?? 'another picker'}.</Alert>
      )}
      {task.status === 'cancelled' && (
        <Alert>The order was cancelled. Return any picked items to their bins.</Alert>
      )}
      {task.routeStatus === 'infeasible' && (
        <Alert tone="amber" title="Route needs a supervisor">
          {task.route.reason ?? 'The cold-chain limit cannot be met in one walk.'} Lines are listed unordered.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="green">{notice}</Alert>}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card
          title="Lines"
          actions={
            task.route.distanceMeters !== null ? (
              <Badge tone="teal">
                {task.route.distanceMeters} m · {task.route.algorithm}
              </Badge>
            ) : undefined
          }
        >
          <form onSubmit={onScan} className="mb-4 flex gap-2" aria-label="Scan item">
            <label htmlFor="scan" className="sr-only">
              Scan or type SKU
            </label>
            <input
              id="scan"
              ref={scanRef}
              className="field font-mono uppercase"
              placeholder="Scan or type SKU, then Enter"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              disabled={task.status !== 'claimed' || !mineNow || completion !== undefined}
              autoComplete="off"
            />
            <Button type="submit" disabled={!scan.trim()}>
              Scan
            </Button>
          </form>
          {activeLine && (
            <div
              className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-4"
              data-testid="active-line"
            >
              <p className="font-semibold">
                {activeLine.productName} <span className="font-mono text-sm">({activeLine.sku})</span>
              </p>
              <p className="text-sm text-slate-600">Ordered: {activeLine.qty}</p>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div>
                  <label className="label" htmlFor="qty">
                    Quantity found
                  </label>
                  <input
                    id="qty"
                    type="number"
                    min={0}
                    max={activeLine.qty}
                    className="field w-28"
                    value={qty}
                    onChange={(e) => setQty(Math.max(0, Math.min(activeLine.qty, Number(e.target.value))))}
                  />
                </div>
                {qty === activeLine.qty ? (
                  <Button busy={busy} onClick={() => void record(activeLine, qty)}>
                    Confirm pick
                  </Button>
                ) : (
                  <Button variant="danger" busy={busy} onClick={() => setConfirmShort(true)}>
                    Record short pick
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setActive(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <ol className="divide-y divide-slate-100">
            {lines.map((l) => {
              const s = states.get(l.orderLineId)!;
              const stop = task.route.stops.find((x) => x.orderLineId === l.orderLineId);
              return (
                <li
                  key={l.orderLineId}
                  className="flex flex-wrap items-start justify-between gap-2 py-3"
                  data-testid={`line-${l.sku}`}
                >
                  <div>
                    <p className="font-medium">
                      {stop ? `${stop.sequence}. ` : ''}
                      {l.productName} <span className="font-mono text-xs text-slate-500">{l.sku}</span>
                    </p>
                    <p className="text-xs text-slate-600">
                      qty {l.qty} ·{' '}
                      {l.location ? `aisle ${l.location.aisle}, ${l.location.pos} m` : 'no bin location'} ·{' '}
                      {l.zone}
                    </p>
                    {s.kind === 'rejected' && (
                      <p className="mt-1 text-xs text-red-700">
                        {reasonText(s.reason)} A supervisor will review it.
                      </p>
                    )}
                    {s.kind === 'unavailable' && (
                      <p className="mt-1 text-xs text-red-700">{reasonText(s.reason)}</p>
                    )}
                  </div>
                  <span data-testid={`line-state-${l.sku}`}>
                    {s.kind === 'todo' && <Badge tone="blue">to pick</Badge>}
                    {s.kind === 'pending' && <Badge tone="amber">saved · waiting to sync ({s.qty})</Badge>}
                    {s.kind === 'done' && (
                      <Badge tone="green">
                        {s.short > 0 ? `picked ${s.qty}, short ${s.short}` : `picked ${s.qty}`}
                      </Badge>
                    )}
                    {s.kind === 'rejected' && <Badge tone="red">rejected</Badge>}
                    {s.kind === 'unavailable' && <Badge tone="red">not available</Badge>}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-600" data-testid="completion-state">
              {completion === 'completed' || completion === 'applied'
                ? 'Task completed.'
                : completion === 'pending'
                  ? 'Completed on this device — waiting to sync.'
                  : completion === 'rejected'
                    ? `Completion was rejected: ${reasonText(c.complete?.reason)}`
                    : resolved
                      ? 'All lines recorded.'
                      : 'Scan each item to record it.'}
            </p>
            <Button
              disabled={!resolved || completion !== undefined || !mineNow || task.status !== 'claimed'}
              busy={busy}
              onClick={() => void complete()}
            >
              Complete task
            </Button>
          </div>
        </Card>
        <Card title="Route">
          {task.route.stops.length > 0 ? (
            <RouteMap stops={task.route.stops} done={done} />
          ) : (
            <p className="text-sm text-slate-600">
              No planned route: {task.route.reason ?? 'pick lines in any order'}.
            </p>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={confirmShort}
        title="Record a short pick?"
        confirmLabel="Record short pick"
        onCancel={() => setConfirmShort(false)}
        onConfirm={() => {
          setConfirmShort(false);
          if (activeLine) void record(activeLine, qty);
        }}
      >
        Only {qty} of {activeLine?.qty} found. The missing quantity is written off as a short pick and the bin
        is flagged for a recount.
      </ConfirmDialog>
    </div>
  );
}
