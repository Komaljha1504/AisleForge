import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { subscribeSync, syncNow, type SyncState } from '../offline/sync';
import { Badge, Button, ConfirmDialog, ago } from './ui';

const NAV: Record<string, { to: string; label: string }[]> = {
  customer: [
    { to: '/shop', label: 'Shop' },
    { to: '/orders', label: 'My orders' },
  ],
  picker: [
    { to: '/tasks', label: 'Pick tasks' },
    { to: '/sync', label: 'Sync center' },
  ],
  supervisor: [
    { to: '/tasks', label: 'Pick tasks' },
    { to: '/supervisor', label: 'Store overview' },
    { to: '/supervisor/rejections', label: 'Rejected ops' },
    { to: '/supervisor/inventory', label: 'Inventory' },
    { to: '/sync', label: 'Sync center' },
  ],
  admin: [
    { to: '/admin/diagnostics', label: 'Diagnostics' },
    { to: '/admin/dead-letters', label: 'Dead letters' },
    { to: '/admin/users', label: 'Users' },
    { to: '/supervisor/inventory', label: 'Inventory' },
  ],
};

export function useSyncState(): SyncState {
  const [s, setS] = useState<SyncState | null>(null);
  useEffect(() => subscribeSync(setS), []);
  return (
    s ?? {
      online: true,
      syncing: false,
      pending: 0,
      rejected: 0,
      heldForOthers: 0,
      lastSyncAt: null,
      lastError: null,
      nextAttemptAt: null,
    }
  );
}

function ConnectionIndicator({ staff }: { staff: boolean }) {
  const s = useSyncState();
  const { offlineSession } = useAuth();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="connection-status">
      {s.online && !offlineSession ? (
        <Badge tone="green">Online</Badge>
      ) : (
        <Badge tone="red">{s.online ? 'Reconnecting' : 'Offline'}</Badge>
      )}
      {staff && (
        <>
          <span data-testid="pending-count">
            <Badge tone={s.pending ? 'amber' : 'neutral'}>{s.pending} pending</Badge>
          </span>
          {s.rejected > 0 && <Badge tone="red">{s.rejected} rejected</Badge>}
          <span className="text-slate-500" data-testid="last-sync">
            {s.syncing ? 'Syncing…' : `Last sync ${ago(s.lastSyncAt)}`}
          </span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium text-brand-700 hover:bg-brand-50"
            onClick={() => void syncNow('manual')}
          >
            Sync now
          </button>
        </>
      )}
    </div>
  );
}

export function Layout() {
  const { user, signOut, pendingForMe } = useAuth();
  const navigate = useNavigate();
  const [confirmPending, setConfirmPending] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return null;
  const items = NAV[user.role] ?? [];
  const staff = user.role === 'picker' || user.role === 'supervisor';

  const requestSignOut = async () => {
    const n = await pendingForMe();
    if (n > 0) setConfirmPending(n);
    else {
      await signOut();
      navigate('/login');
    }
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/icon.svg" alt="" className="h-8 w-8" />
            <span className="text-lg font-bold tracking-tight">AisleForge</span>
          </div>
          <button
            type="button"
            className="ml-auto rounded-md border border-slate-300 px-2 py-1 text-sm md:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            Menu
          </button>
          <nav
            id="main-nav"
            aria-label="Main"
            className={`${menuOpen ? 'flex' : 'hidden'} w-full flex-col gap-1 md:ml-4 md:flex md:w-auto md:flex-row`}
          >
            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`
                }
              >
                {i.label}
              </NavLink>
            ))}
          </nav>
          <div
            className={`${menuOpen ? 'flex' : 'hidden'} w-full items-center justify-between gap-3 md:ml-auto md:flex md:w-auto`}
          >
            <span className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900" data-testid="signed-in-as">
                {user.displayName}
              </span>{' '}
              · {user.role}
              {user.storeId ? ` · store ${user.storeId}` : ''}
            </span>
            <Button variant="secondary" onClick={() => void requestSignOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <div className="border-t border-slate-100 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-1.5">
            <ConnectionIndicator staff={staff} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <ConfirmDialog
        open={confirmPending !== null}
        title="Unsynchronized work on this device"
        confirmLabel="Sign out anyway"
        onCancel={() => setConfirmPending(null)}
        onConfirm={async () => {
          setConfirmPending(null);
          await signOut();
          navigate('/login');
        }}
      >
        <p>
          {confirmPending} operation(s) have not reached the server yet. They stay safely on this device and
          are sent the next time <strong>you</strong> sign in here. Other employees cannot see or send them.
        </p>
      </ConfirmDialog>
    </div>
  );
}
