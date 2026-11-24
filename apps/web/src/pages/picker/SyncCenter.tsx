import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useSyncState } from '../../components/Layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  ago,
  statusTone,
  when,
} from '../../components/ui';
import { api, describeError } from '../../lib/api';
import type { QueuedOp } from '../../lib/types';
import { deviceId, dismissRejected, opsFor, storageEstimate } from '../../offline/db';
import { refreshCounts, syncNow } from '../../offline/sync';
import { reasonText } from './Pick';

interface ServerRejection {
  opId: string;
  type: string;
  reason: string;
  receivedAt: string;
  reviewStatus: string;
  reviewNote: string | null;
}

export function SyncCenterPage() {
  const { user, offlineSession } = useAuth();
  const sync = useSyncState();
  const [ops, setOps] = useState<QueuedOp[]>([]);
  const [dev, setDev] = useState('');
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  const [server, setServer] = useState<ServerRejection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setOps((await opsFor(user.id)).sort((a, b) => b.seq - a.seq));
    setDev(await deviceId());
    setStorage(await storageEstimate());
    if (sync.online && !offlineSession)
      try {
        setServer((await api<{ rejections: ServerRejection[] }>('/api/v1/sync/rejections/mine')).rejections);
      } catch {
        setServer(null);
      }
  }, [user, sync.online, offlineSession]);
  useEffect(() => {
    void load();
  }, [load, sync.pending, sync.lastSyncAt]);

  const persist = async () => {
    try {
      const ok = await navigator.storage?.persist?.();
      if (!ok)
        setError('The browser declined persistent storage; data may be evicted under storage pressure.');
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const pending = ops.filter((o) => o.status === 'pending');
  const rejected = ops.filter((o) => o.status === 'rejected');
  const applied = ops.filter((o) => o.status === 'applied').slice(0, 20);
  const usedPct = storage && storage.quota ? Math.round((storage.usage / storage.quota) * 1000) / 10 : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sync center"
        subtitle={`Device ${dev.slice(0, 8)} · last sync ${ago(sync.lastSyncAt)}`}
        actions={
          <Button onClick={() => void syncNow('manual')} busy={sync.syncing} disabled={!sync.online}>
            Sync now
          </Button>
        }
      />
      {error && <Alert>{error}</Alert>}
      {sync.lastError && <Alert tone="amber">{sync.lastError}</Alert>}
      {sync.heldForOthers > 0 && (
        <Alert tone="blue">
          {sync.heldForOthers} operation(s) recorded by another employee on this device are held for them and
          sent when they sign in.
        </Alert>
      )}
      <div className="grid gap-5 md:grid-cols-3">
        <Card title="Waiting to sync">
          <p className="text-3xl font-bold" data-testid="sync-pending">
            {pending.length}
          </p>
        </Card>
        <Card title="Rejected by the server">
          <p className="text-3xl font-bold text-red-700">{rejected.length}</p>
        </Card>
        <Card title="Device storage">
          {storage ? (
            <div className="space-y-1 text-sm">
              <p>
                {(storage.usage / 1048576).toFixed(1)} MB used of {(storage.quota / 1048576).toFixed(0)} MB (
                {usedPct}%)
              </p>
              <p>
                {storage.persisted ? (
                  <Badge tone="green">persistent</Badge>
                ) : (
                  <Badge tone="amber">may be evicted</Badge>
                )}
              </p>
              {!storage.persisted && (
                <Button variant="secondary" onClick={() => void persist()}>
                  Keep data on this device
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-600">Not reported by this browser.</p>
          )}
        </Card>
      </div>
      <Card title="Rejected operations">
        {rejected.length === 0 ? (
          <EmptyState title="Nothing rejected" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rejected.map((o) => (
              <li key={o.opId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="text-sm">
                  <p className="font-medium">
                    {o.type === 'pick.confirm'
                      ? `Pick ${String(o.payload.scannedSku)} × ${String(o.payload.pickedQty)}`
                      : 'Task completion'}
                  </p>
                  <p className="text-red-700">{reasonText(o.reason)}</p>
                  <p className="text-xs text-slate-500">
                    recorded {when(o.createdAt)} · a supervisor reviews every rejection
                  </p>
                </div>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await dismissRejected(o.opId);
                    await refreshCounts();
                    await load();
                  }}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Queue (newest first)">
        {pending.length + applied.length === 0 ? (
          <EmptyState title="No recent operations" />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1">#</th>
                <th>Operation</th>
                <th>Recorded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...pending, ...applied].map((o) => (
                <tr key={o.opId}>
                  <td className="py-1.5 font-mono text-xs">{o.seq}</td>
                  <td>
                    {o.type === 'pick.confirm'
                      ? `pick ${String(o.payload.scannedSku)} × ${String(o.payload.pickedQty)}`
                      : 'complete task'}
                  </td>
                  <td>{when(o.createdAt)}</td>
                  <td>
                    <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {server && server.length > 0 && (
        <Card title="Supervisor review of my rejected operations">
          <ul className="divide-y divide-slate-100 text-sm">
            {server.map((r) => (
              <li key={r.opId} className="py-2">
                <Badge tone={r.reviewStatus === 'open' ? 'amber' : 'green'}>{r.reviewStatus}</Badge>{' '}
                {reasonText(r.reason)}
                {r.reviewNote && <span className="text-slate-600"> — “{r.reviewNote}”</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
