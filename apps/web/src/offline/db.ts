import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CachedTask, OpType, Profile, QueuedOp } from '../lib/types';

/**
 * Device-local store (ADR-004). Everything is scoped by userId: on a shared device one employee never sees or
 * uploads another's data. Operations are deleted only after the server settled them (applied/rejected); rejected
 * ones stay visible until the employee dismisses them.
 */
interface AisleForgeDB extends DBSchema {
  meta: { key: string; value: unknown };
  tasks: { key: string; value: CachedTask; indexes: { byUser: string } };
  ops: {
    key: string;
    value: QueuedOp;
    indexes: { byUserSeq: [string, number]; byUserStatus: [string, string] };
  };
}

let dbp: Promise<IDBPDatabase<AisleForgeDB>> | null = null;
export function db(): Promise<IDBPDatabase<AisleForgeDB>> {
  dbp ??= openDB<AisleForgeDB>('aisleforge', 1, {
    upgrade(d) {
      d.createObjectStore('meta');
      const t = d.createObjectStore('tasks', { keyPath: 'taskId' });
      t.createIndex('byUser', 'userId');
      const o = d.createObjectStore('ops', { keyPath: 'opId' });
      o.createIndex('byUserSeq', ['userId', 'seq']);
      o.createIndex('byUserStatus', ['userId', 'status']);
    },
  });
  return dbp;
}

export class StorageFullError extends Error {
  constructor() {
    super('This device is out of storage. Synchronize and free space before recording more picks.');
    this.name = 'StorageFullError';
  }
}

const isQuota = (e: unknown) =>
  e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

/** One id per browser profile/installation, created once and kept across restarts. */
export async function deviceId(): Promise<string> {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  let id = (await tx.store.get('deviceId')) as string | undefined;
  if (!id) {
    id = crypto.randomUUID();
    await tx.store.put(id, 'deviceId');
  }
  await tx.done;
  return id;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}
export async function deleteMeta(key: string): Promise<void> {
  await (await db()).delete('meta', key);
}

/** Non-sensitive profile of the last signed-in user, so a picker can keep working through an offline restart. */
export const saveProfile = (p: Profile) => setMeta('profile', p);
export const loadProfile = () => getMeta<Profile>('profile');

export async function cacheTask(userId: string, task: CachedTask['task']): Promise<void> {
  const d = await db();
  const tx = d.transaction('tasks', 'readwrite');
  const prev = await tx.store.get(task.id);
  // Keep the device's own not-yet-acknowledged state; the server snapshot replaces everything else.
  await tx.store.put({
    taskId: task.id,
    userId,
    task,
    local: prev?.userId === userId ? prev.local : {},
    ...(prev?.userId === userId && prev.complete ? { complete: prev.complete } : {}),
    cachedAt: new Date().toISOString(),
  });
  await tx.done;
}

export async function cachedTasks(userId: string): Promise<CachedTask[]> {
  return (await db()).getAllFromIndex('tasks', 'byUser', userId);
}
export async function cachedTask(taskId: string): Promise<CachedTask | undefined> {
  return (await db()).get('tasks', taskId);
}
export async function dropCachedTasks(userId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction('tasks', 'readwrite');
  for (const t of await tx.store.index('byUser').getAll(userId)) await tx.store.delete(t.taskId);
  await tx.done;
}

/**
 * Records an operation ATOMICALLY with its effect on local state: the sequence counter, the op and the task's local
 * line state are written in ONE IndexedDB transaction. If anything fails (e.g. quota), nothing is written and the
 * action is reported as not recorded — it is never half-applied or silently dropped.
 */
export async function recordOp(args: {
  userId: string;
  type: OpType;
  taskId: string;
  payload: Record<string, unknown>;
}): Promise<QueuedOp> {
  const dev = await deviceId();
  const d = await db();
  try {
    const tx = d.transaction(['meta', 'ops', 'tasks'], 'readwrite');
    const meta = tx.objectStore('meta');
    const seq = (((await meta.get('seq')) as number | undefined) ?? 0) + 1;
    const op: QueuedOp = {
      opId: crypto.randomUUID(),
      seq,
      userId: args.userId,
      deviceId: dev,
      type: args.type,
      taskId: args.taskId,
      payload: args.payload,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    await meta.put(seq, 'seq');
    await tx.objectStore('ops').add(op);
    const tasks = tx.objectStore('tasks');
    const cached = await tasks.get(args.taskId);
    if (cached && cached.userId === args.userId) {
      if (args.type === 'pick.confirm') {
        const lineId = String(args.payload.orderLineId);
        cached.local[lineId] = {
          pickedQty: Number(args.payload.pickedQty),
          scannedSku: String(args.payload.scannedSku),
          opId: op.opId,
          status: 'pending',
        };
      } else {
        cached.complete = { opId: op.opId, status: 'pending' };
      }
      await tasks.put(cached);
    }
    await tx.done;
    return op;
  } catch (e) {
    if (isQuota(e) || (e instanceof Error && isQuota((e as { cause?: unknown }).cause)))
      throw new StorageFullError();
    throw e;
  }
}

export async function opsFor(userId: string, status?: QueuedOp['status']): Promise<QueuedOp[]> {
  const all = await (
    await db()
  ).getAllFromIndex('ops', 'byUserSeq', IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]));
  return status ? all.filter((o) => o.status === status) : all;
}

/** Pending operations recorded by OTHER employees on this device (shared device): held, never uploaded by us. */
export async function pendingForOthers(userId: string): Promise<number> {
  const all = await (await db()).getAll('ops');
  return all.filter((o) => o.userId !== userId && o.status === 'pending').length;
}

/** Applies the server's verdict for an operation to the op log and to the cached task, atomically. */
export async function settleOp(
  opId: string,
  verdict: { status: 'applied' | 'rejected'; reason?: string; message?: string },
): Promise<void> {
  const d = await db();
  const tx = d.transaction(['ops', 'tasks'], 'readwrite');
  const op = await tx.objectStore('ops').get(opId);
  if (!op) return void (await tx.done);
  op.status = verdict.status;
  if (verdict.reason) op.reason = verdict.reason;
  if (verdict.message) op.message = verdict.message;
  op.settledAt = new Date().toISOString();
  await tx.objectStore('ops').put(op);
  const cached = await tx.objectStore('tasks').get(op.taskId);
  if (cached) {
    if (op.type === 'pick.confirm') {
      const lineId = String(op.payload.orderLineId);
      const st = cached.local[lineId];
      if (st && st.opId === opId) {
        st.status = verdict.status;
        if (verdict.reason) st.reason = verdict.reason;
      }
    } else if (cached.complete?.opId === opId) {
      cached.complete.status = verdict.status;
      if (verdict.reason) cached.complete.reason = verdict.reason;
    }
    await tx.objectStore('tasks').put(cached);
  }
  await tx.done;
}

/** Removes settled-applied operations older than the newest `keep` (bounded history); rejected ones are kept. */
export async function pruneApplied(userId: string, keep = 200): Promise<void> {
  const applied = (await opsFor(userId, 'applied')).sort((a, b) => b.seq - a.seq);
  const d = await db();
  const tx = d.transaction('ops', 'readwrite');
  for (const o of applied.slice(keep)) await tx.store.delete(o.opId);
  await tx.done;
}

export async function dismissRejected(opId: string): Promise<void> {
  const d = await db();
  const op = await d.get('ops', opId);
  if (op?.status === 'rejected') await d.delete('ops', opId);
}

export async function storageEstimate(): Promise<{
  usage: number;
  quota: number;
  persisted: boolean;
} | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
}
