import { api, ApiError, hasAccessToken, OfflineError } from '../lib/api';
import type { QueuedOp, TaskView } from '../lib/types';
import {
  cacheTask,
  cachedTasks,
  deviceId,
  getMeta,
  opsFor,
  pendingForOthers,
  pruneApplied,
  setMeta,
  settleOp,
} from './db';

/**
 * Synchronization engine (ADR-004).
 *  - One upload at a time per device: Web Locks across tabs (fallback: in-tab flag), BroadcastChannel tells the
 *    other tabs to refresh their state.
 *  - Uploads this employee's pending ops in seq order (batches of 50). The server answers per op:
 *      applied / duplicate(original=applied)  → settled as applied
 *      rejected / duplicate(original=rejected) → settled as rejected (kept visible with its reason)
 *      retry                                   → stop; resend later, in order
 *  - Network loss or 429 stops the run; nothing is lost (ops stay pending in IndexedDB).
 * Triggers: online event, tab becomes visible, a jittered 20–30 s timer, right after recording an op, manual.
 */
export interface SyncState {
  online: boolean;
  syncing: boolean;
  pending: number;
  rejected: number;
  heldForOthers: number;
  lastSyncAt: string | null;
  lastError: string | null;
  nextAttemptAt: number | null;
}

type Listener = (s: SyncState) => void;
const listeners = new Set<Listener>();
let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  rejected: 0,
  heldForOthers: 0,
  lastSyncAt: null,
  lastError: null,
  nextAttemptAt: null,
};
let currentUser: string | null = null;
let inTabRunning = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('aisleforge-sync');

const emit = (patch: Partial<SyncState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
};
export const subscribeSync = (l: Listener): (() => void) => {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
};
export const syncState = (): SyncState => state;

export async function refreshCounts(): Promise<void> {
  if (!currentUser) return emit({ pending: 0, rejected: 0, heldForOthers: 0 });
  const ops = await opsFor(currentUser);
  emit({
    pending: ops.filter((o) => o.status === 'pending').length,
    rejected: ops.filter((o) => o.status === 'rejected').length,
    heldForOthers: await pendingForOthers(currentUser),
    lastSyncAt: (await getMeta<string>(`lastSync:${currentUser}`)) ?? null,
  });
}

channel?.addEventListener('message', () => void refreshCounts());

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  emit({ nextAttemptAt: Date.now() + ms });
  timer = setTimeout(() => void syncNow('timer'), ms);
}
const jitter = (base: number) => base + Math.floor(Math.random() * 10_000);

export function startSync(userId: string): void {
  currentUser = userId;
  void refreshCounts();
  schedule(1000);
}
export function stopSync(): void {
  currentUser = null;
  if (timer) clearTimeout(timer);
  timer = null;
  emit({ pending: 0, rejected: 0, heldForOthers: 0, nextAttemptAt: null });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    emit({ online: true });
    void syncNow('online');
  });
  window.addEventListener('offline', () => emit({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow('visible');
  });
}

interface SyncResult {
  opId: string;
  seq: number;
  status: 'applied' | 'duplicate' | 'rejected' | 'retry';
  original?: 'applied' | 'rejected';
  reason?: string;
  message?: string;
  retryAfterSeconds?: number;
}

async function runOnce(userId: string): Promise<void> {
  const dev = await deviceId();
  for (;;) {
    const pending = (await opsFor(userId, 'pending')).sort((a, b) => a.seq - b.seq).slice(0, 50);
    if (pending.length === 0) break;
    const body = {
      deviceId: dev,
      ops: pending.map((o: QueuedOp) => ({
        opId: o.opId,
        seq: o.seq,
        type: o.type,
        taskId: o.taskId,
        payload: o.payload,
        clientCreatedAt: o.createdAt,
      })),
    };
    const res = await api<{ results: SyncResult[] }>('/api/v1/sync', { method: 'POST', body });
    let retryAfter: number | null = null;
    for (const r of res.results) {
      if (r.status === 'applied' || (r.status === 'duplicate' && r.original === 'applied'))
        await settleOp(r.opId, { status: 'applied' });
      else if (r.status === 'rejected' || (r.status === 'duplicate' && r.original === 'rejected'))
        await settleOp(r.opId, {
          status: 'rejected',
          reason: r.reason ?? 'rejected',
          ...(r.message ? { message: r.message } : {}),
        });
      else if (r.status === 'retry') {
        retryAfter = r.retryAfterSeconds ?? 5;
        break;
      }
    }
    channel?.postMessage('changed');
    if (retryAfter !== null) {
      schedule(retryAfter * 1000);
      return;
    }
  }
  await setMeta(`lastSync:${userId}`, new Date().toISOString());
  await pruneApplied(userId);
  // Refresh the cached snapshots of this employee's tasks (status may have changed server-side).
  for (const t of await cachedTasks(userId)) {
    try {
      const { task } = await api<{ task: TaskView }>(`/api/v1/pick-tasks/${t.taskId}`);
      await cacheTask(userId, task);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      throw e;
    }
  }
}

export async function syncNow(trigger: string): Promise<void> {
  const userId = currentUser;
  if (!userId) return;
  if (!navigator.onLine) {
    emit({ online: false });
    return;
  }
  if (!hasAccessToken()) {
    // Offline restart: the access token must be re-obtained (AuthProvider retries the refresh when online).
    emit({ lastError: 'Waiting for the server to confirm your session' });
    schedule(jitter(15_000));
    return;
  }
  const work = async () => {
    if (inTabRunning) return;
    inTabRunning = true;
    emit({ syncing: true, lastError: null });
    try {
      await runOnce(userId);
      emit({ online: true });
      schedule(jitter(20_000));
    } catch (e) {
      if (e instanceof OfflineError) {
        emit({ online: false, lastError: e.message });
        schedule(jitter(15_000));
      } else if (e instanceof ApiError && e.status === 429) {
        emit({ lastError: 'Server busy; retrying shortly' });
        schedule((e.retryAfterSeconds ?? 10) * 1000);
      } else {
        emit({ lastError: e instanceof Error ? e.message : String(e) });
        schedule(jitter(30_000));
      }
    } finally {
      inTabRunning = false;
      emit({ syncing: false });
      await refreshCounts();
    }
  };
  void trigger;
  if (navigator.locks?.request)
    await navigator.locks.request('aisleforge-sync', { ifAvailable: true }, async (lock) => {
      if (lock) await work();
      else {
        // Another tab is uploading this device's queue; it will broadcast when done. Check again later.
        schedule(jitter(20_000));
        await refreshCounts();
      }
    });
  else await work();
}
