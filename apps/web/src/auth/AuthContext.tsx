import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  login as apiLogin,
  logoutServer,
  OfflineError,
  onSessionLost,
  refreshSession,
} from '../lib/api';
import type { Profile } from '../lib/types';
import {
  deleteMeta,
  dropCachedTasks,
  getMeta,
  loadProfile,
  opsFor,
  saveProfile,
  setMeta,
} from '../offline/db';
import { startSync, stopSync, syncNow } from '../offline/sync';

/**
 * Session handling.
 *  - Online start: the HttpOnly refresh cookie is exchanged for an access token (kept in memory only).
 *  - OFFLINE start (browser restarted without network): if this device's last session was NOT explicitly signed out,
 *    the cached non-sensitive profile is used in "offline mode" — the picker can continue the tasks already on the
 *    device; every action is queued and nothing claims server success. When the network returns, the session is
 *    confirmed by a refresh before anything is uploaded; if the server refuses it, the employee must sign in again
 *    (queued operations stay on the device for them).
 *  - Sign-out with unsynchronized operations is confirmed by the UI; the operations are kept (held for that employee).
 */
interface AuthValue {
  user: Profile | null;
  offlineSession: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  pendingForMe: () => Promise<number>;
}

const Ctx = createContext<AuthValue | null>(null);

/** Sends a sign-out that could not reach the server earlier. Safe to call repeatedly. */
async function completePendingLogout(): Promise<void> {
  if (!(await getMeta<boolean>('pendingLogout'))) return;
  try {
    await logoutServer();
    await deleteMeta('pendingLogout');
  } catch {
    /* still offline: retried on the next 'online' event or start */
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => void completePendingLogout());

async function fetchProfile(): Promise<Profile> {
  const { user } = await api<{ user: Profile }>('/api/v1/me');
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [offlineSession, setOfflineSession] = useState(false);
  const [loading, setLoading] = useState(true);

  const adopt = useCallback(async (p: Profile, offline: boolean) => {
    setUser(p);
    setOfflineSession(offline);
    await setMeta('activeSession', p.id);
    if (p.role === 'picker' || p.role === 'supervisor') startSync(p.id);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      // Explicit sign-out on this device (possibly while offline): never resurrect that session. Finish the
      // server-side logout (revokes the refresh-token family) as soon as the server is reachable.
      if (await getMeta<boolean>('pendingLogout')) {
        await completePendingLogout();
        setUser(null);
        return;
      }
      if (!(await getMeta<string>('activeSession'))) {
        setUser(null);
        return;
      }
      const refreshed = await refreshSession();
      if (!refreshed) {
        await deleteMeta('activeSession');
        setUser(null);
        return;
      }
      const p = await fetchProfile();
      await saveProfile(p);
      await adopt(p, false);
    } catch (e) {
      if (e instanceof OfflineError) {
        const active = await getMeta<string>('activeSession');
        const cached = await loadProfile();
        if (active && cached && cached.id === active) await adopt(cached, true);
      }
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => {
    void bootstrap();
    onSessionLost(() => {
      stopSync();
      setUser(null);
      void deleteMeta('activeSession');
    });
  }, [bootstrap]);

  // Offline session → confirm with the server as soon as the network is back, then synchronize.
  useEffect(() => {
    if (!offlineSession) return;
    const confirm = async () => {
      try {
        const refreshed = await refreshSession();
        if (!refreshed) {
          stopSync();
          setUser(null);
          setOfflineSession(false);
          await deleteMeta('activeSession');
          return;
        }
        setOfflineSession(false);
        await syncNow('session-confirmed');
      } catch {
        /* still offline */
      }
    };
    window.addEventListener('online', confirm);
    const t = setInterval(() => navigator.onLine && void confirm(), 15_000);
    return () => {
      window.removeEventListener('online', confirm);
      clearInterval(t);
    };
  }, [offlineSession]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const prev = await loadProfile();
      await completePendingLogout(); // revoke a previous employee's session first, if its logout is still owed
      await deleteMeta('pendingLogout');
      await apiLogin(email, password);
      const p = await fetchProfile();
      // Shared device: a different employee never inherits the previous employee's cached tasks.
      if (prev && prev.id !== p.id) await dropCachedTasks(prev.id);
      await saveProfile(p);
      await adopt(p, false);
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    const me = user;
    stopSync();
    await deleteMeta('activeSession'); // from now on this device never restores the session by itself
    try {
      await logoutServer();
    } catch {
      // Offline: the refresh cookie is still valid server-side. Owe the logout and send it as soon as possible,
      // so the next person to open the app on this device cannot be signed in as this employee (e2e finding).
      await setMeta('pendingLogout', true);
    }
    if (me) await dropCachedTasks(me.id); // per-user cached data is cleared; queued operations are KEPT
    setUser(null);
    setOfflineSession(false);
  }, [user]);

  const pendingForMe = useCallback(
    async () => (user ? (await opsFor(user.id, 'pending')).length : 0),
    [user],
  );

  const value = useMemo(
    () => ({ user, offlineSession, loading, signIn, signOut, pendingForMe }),
    [user, offlineSession, loading, signIn, signOut, pendingForMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
