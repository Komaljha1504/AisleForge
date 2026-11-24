import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Spinner,
  ago,
  statusTone,
  when,
} from '../../components/ui';
import { api, describeError } from '../../lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any -- diagnostics payloads are rendered generically */

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className={`text-xl font-bold ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

export function DiagnosticsPage() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setS(await api('/internal/status'));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  if (!s) return error ? <Alert>{error}</Alert> : <Spinner />;
  const workers: any[] = s.workers ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Diagnostics"
        subtitle="API process, PostgreSQL pools, outbox and worker/Kafka state (refreshes every 5 s)."
      />
      {error && <Alert tone="amber">Last refresh failed: {error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Outbox unpublished"
          value={s.outbox?.unpublished ?? '—'}
          tone={s.outbox?.unpublished > 100 ? 'text-amber-700' : ''}
        />
        <Stat
          label="Oldest unpublished"
          value={s.outbox?.oldestAgeSeconds ? `${Math.round(s.outbox.oldestAgeSeconds)} s` : '—'}
        />
        <Stat label="API memory" value={`${s.process.memoryMB} MB`} />
        <Stat label="Event-loop p99" value={`${s.process.eventLoopDelayMs.p99.toFixed(1)} ms`} />
      </div>
      <Card title="PostgreSQL pools">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Pool</th>
              <th>Max</th>
              <th>Open</th>
              <th>Idle</th>
              <th>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {s.postgres.pools.map((p: any) => (
              <tr key={p.name}>
                <td className="py-1">{p.name}</td>
                <td>{p.max}</td>
                <td>{p.total}</td>
                <td>{p.idle}</td>
                <td className={p.waiting ? 'font-bold text-amber-700' : ''}>{p.waiting}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">Transactions: {JSON.stringify(s.postgres.transactions)}</p>
      </Card>
      <Card title={`Workers (${workers.length})`}>
        {workers.length === 0 ? (
          <EmptyState title="No worker has reported">
            Start the worker process; it reports every few seconds.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {workers.map((w: any) => (
              <div key={w.workerId} className="rounded-lg border border-slate-200 p-4" data-testid="worker">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-sm font-semibold">{w.workerId}</p>
                  {w.stale ? (
                    <Badge tone="red">stale ({w.ageSeconds}s)</Badge>
                  ) : (
                    <Badge tone="green">reporting</Badge>
                  )}
                  {w.status?.outbox?.leader && <Badge tone="teal">outbox leader</Badge>}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Published" value={w.status?.outbox?.publishedTotal ?? 0} />
                  <Stat
                    label="Producer"
                    value={w.status?.kafka?.producer?.connected ? 'connected' : 'disconnected'}
                  />
                  <Stat
                    label="Consumer lag"
                    value={Object.values(w.status?.kafka?.lag ?? {})
                      .flat()
                      .reduce((n: number, p: any) => n + (p?.lag ?? 0), 0)}
                  />
                  <Stat
                    label="Dead letters (open)"
                    value={w.status?.deadLetters?.dead ?? 0}
                    tone={w.status?.deadLetters?.dead ? 'text-red-700' : ''}
                  />
                </div>
                {(w.status?.kafka?.consumers ?? []).map((c: any) => (
                  <p key={c.name} className="mt-2 text-xs text-slate-600">
                    {c.name}: applied {c.stats.applied}, duplicates {c.stats.duplicate}, stale {c.stats.stale}
                    , dead-lettered {c.stats.dead_lettered}, retries {c.stats.retries}; last processed{' '}
                    {ago(c.lastProcessedAt)}
                    {c.lastError && <span className="text-red-700"> · last error: {c.lastError}</span>}
                  </p>
                ))}
                {w.status?.outbox?.lastError && (
                  <p className="mt-1 text-xs text-red-700">Publisher: {w.status.outbox.lastError}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function DeadLettersPage() {
  const [items, setItems] = useState<any[] | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [discard, setDiscard] = useState<any>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: any[] }>('/internal/dead-letters?limit=100')).items);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const replay = async (id: number) => {
    setError(null);
    try {
      await api(`/internal/dead-letters/${id}/replay`, { method: 'POST' });
      setInfo(`Replay of #${id} requested; the worker re-publishes it within a few seconds.`);
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dead letters"
        subtitle="Events consumers could not process. Inspect, replay after a fix, or discard with a reason."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      {error && <Alert>{error}</Alert>}
      {info && <Alert tone="green">{info}</Alert>}
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No dead letters">Every consumed event was processed.</EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">#</th>
                  <th>Kind</th>
                  <th>Event</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2 font-mono">{d.id}</td>
                    <td>{d.errorKind}</td>
                    <td>{d.eventType ?? '—'}</td>
                    <td className="max-w-xs truncate" title={d.errorMessage}>
                      {d.errorMessage}
                    </td>
                    <td>
                      <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                    </td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      <Button
                        variant="ghost"
                        onClick={async () =>
                          setDetail(
                            (await api<{ deadLetter: any }>(`/internal/dead-letters/${d.id}`)).deadLetter,
                          )
                        }
                      >
                        Inspect
                      </Button>
                      {['dead', 'replayed'].includes(d.status) && (
                        <>
                          <Button variant="secondary" onClick={() => void replay(d.id)}>
                            Replay
                          </Button>
                          <Button variant="ghost" onClick={() => setDiscard(d)}>
                            Discard
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {detail && (
        <Card
          title={`Dead letter #${detail.id}`}
          actions={
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Close
            </Button>
          }
        >
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Source</dt>
              <dd className="font-mono">
                {detail.topic}/{detail.partition}/{detail.offset}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Attempts</dt>
              <dd>{detail.attempts}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Correlation id</dt>
              <dd className="font-mono">{detail.correlationId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Created</dt>
              <dd>{when(detail.createdAt)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-red-700">{detail.errorMessage}</p>
          <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            {detail.rawValue}
          </pre>
        </Card>
      )}
      <ConfirmDialog
        open={discard !== null}
        title={`Discard dead letter #${discard?.id}?`}
        confirmLabel="Discard"
        onCancel={() => setDiscard(null)}
        onConfirm={async () => {
          try {
            await api(`/internal/dead-letters/${discard.id}/discard`, { method: 'POST', body: { note } });
            setDiscard(null);
            setNote('');
            await load();
          } catch (e) {
            setError(describeError(e));
            setDiscard(null);
          }
        }}
      >
        <label className="label" htmlFor="discard-note">
          Why is it safe to discard? (recorded in the audit log)
        </label>
        <textarea
          id="discard-note"
          className="field"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          minLength={3}
        />
      </ConfirmDialog>
    </div>
  );
}

export function UsersPage() {
  const [users, setUsers] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'picker',
    storeId: '1',
  });
  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: any[] }>('/api/v1/admin/users?limit=200')).users);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/admin/users', {
        method: 'POST',
        body: { ...form, storeId: form.role === 'admin' ? null : Number(form.storeId) },
      });
      setInfo(`Created ${form.email}`);
      setForm({ ...form, email: '', displayName: '', password: '' });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };
  const unlock = async (id: string) => {
    try {
      await api(`/api/v1/admin/users/${id}/unlock-login`, { method: 'POST' });
      setInfo('Login throttles cleared (audited).');
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Users" subtitle="Create staff accounts, change roles, clear login throttles." />
      {error && <Alert>{error}</Alert>}
      {info && <Alert tone="green">{info}</Alert>}
      <Card title="New staff account">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input
            aria-label="Email"
            placeholder="email"
            type="email"
            className="field"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <input
            aria-label="Name"
            placeholder="name"
            className="field"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            required
          />
          <input
            aria-label="Initial password"
            placeholder="initial password (12+)"
            type="password"
            className="field"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={12}
          />
          <select
            aria-label="Role"
            className="field"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            <option value="picker">picker</option>
            <option value="supervisor">supervisor</option>
            <option value="admin">admin</option>
          </select>
          <div className="flex gap-2">
            <input
              aria-label="Store"
              type="number"
              min={1}
              className="field"
              value={form.storeId}
              disabled={form.role === 'admin'}
              onChange={(e) => setForm({ ...form, storeId: e.target.value })}
            />
            <Button type="submit">Create</Button>
          </div>
        </form>
      </Card>
      <Card title="Accounts">
        {!users ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Store</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2">{u.displayName}</td>
                    <td>{u.email}</td>
                    <td>
                      <Badge tone="teal">{u.role}</Badge>
                    </td>
                    <td>{u.storeId ?? '—'}</td>
                    <td className="text-right">
                      <Button variant="ghost" onClick={() => void unlock(u.id)}>
                        Clear login throttle
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
