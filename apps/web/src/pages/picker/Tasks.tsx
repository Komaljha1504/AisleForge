import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useSyncState } from '../../components/Layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  statusTone,
  when,
} from '../../components/ui';
import { api, ApiError, describeError, OfflineError } from '../../lib/api';
import type { CachedTask, TaskView } from '../../lib/types';
import { cacheTask, cachedTasks } from '../../offline/db';

function TaskRow({ t, action }: { t: TaskView; action: React.ReactNode }) {
  const lines = t.lines?.length ?? t.route.stops.length + t.route.unrouted.length;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium text-slate-900">
          Order <span className="font-mono text-sm">{t.orderId.slice(-8)}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge tone={statusTone(t.status)}>{t.status}</Badge>
          <Badge tone={statusTone(t.routeStatus)}>route {t.routeStatus}</Badge>
          <span>{lines} line(s)</span>
          {t.route.distanceMeters !== null && <span>{t.route.distanceMeters} m</span>}
          <span>created {when(t.createdAt)}</span>
        </p>
      </div>
      {action}
    </li>
  );
}

export function TasksPage() {
  const { user, offlineSession } = useAuth();
  const sync = useSyncState();
  const navigate = useNavigate();
  const [mine, setMine] = useState<CachedTask[]>([]);
  const [available, setAvailable] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const online = sync.online && !offlineSession;

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      if (online) {
        const [m, a] = await Promise.all([
          api<{ tasks: TaskView[] }>('/api/v1/pick-tasks?scope=mine'),
          api<{ tasks: TaskView[] }>('/api/v1/pick-tasks?scope=available'),
        ]);
        // Download full details of my tasks so they remain available offline.
        for (const t of m.tasks) {
          const { task } = await api<{ task: TaskView }>(`/api/v1/pick-tasks/${t.id}`);
          await cacheTask(user.id, task);
        }
        setAvailable(a.tasks);
      } else setAvailable(null);
    } catch (e) {
      if (!(e instanceof OfflineError)) setError(describeError(e));
      setAvailable(null);
    } finally {
      const cached = await cachedTasks(user.id);
      setMine(
        cached.filter(
          (c) => c.task.status !== 'cancelled' || Object.values(c.local).some((l) => l.status !== 'applied'),
        ),
      );
      setLoading(false);
    }
  }, [user, online]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (id: string) => {
    setClaiming(id);
    setError(null);
    try {
      const { task } = await api<{ task: TaskView }>(`/api/v1/pick-tasks/${id}/claim`, { method: 'POST' });
      await cacheTask(user!.id, task);
      navigate(`/tasks/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError('Someone else took this task a moment ago.');
      else setError(describeError(e));
      void load();
    } finally {
      setClaiming(null);
    }
  };

  if (loading) return <Spinner />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pick tasks"
        subtitle={`Store ${user?.storeId ?? '—'}`}
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      {error && <Alert>{error}</Alert>}
      {!online && (
        <Alert tone="amber" title="Working offline">
          Your claimed tasks are available on this device. Picks are saved here and sent when the connection
          returns. New tasks can only be claimed online.
        </Alert>
      )}
      <Card title="My tasks">
        {mine.length === 0 ? (
          <EmptyState title="No tasks on this device">Claim a task below to start picking.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="my-tasks">
            {mine.map((c) => (
              <TaskRow
                key={c.taskId}
                t={c.task}
                action={
                  <Link
                    to={`/tasks/${c.taskId}`}
                    className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
                  >
                    {c.task.status === 'completed' || c.complete ? 'View' : 'Pick'}
                  </Link>
                }
              />
            ))}
          </ul>
        )}
      </Card>
      <Card title="Available to claim">
        {available === null ? (
          <EmptyState title="Unavailable offline">
            Claiming needs the server, so it is not possible while offline.
          </EmptyState>
        ) : available.length === 0 ? (
          <EmptyState title="Nothing waiting">New orders appear here as soon as they are placed.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="available-tasks">
            {available.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                action={
                  <Button busy={claiming === t.id} disabled={!online} onClick={() => void claim(t.id)}>
                    Claim
                  </Button>
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
