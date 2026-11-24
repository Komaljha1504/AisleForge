import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button } from '../components/ui';
import { api, ApiError, describeError } from '../lib/api';

export const homeFor = (role: string) =>
  ({ customer: '/shop', picker: '/tasks', supervisor: '/supervisor', admin: '/admin/diagnostics' })[role] ??
  '/';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === 'register') {
        await api('/api/v1/auth/register', {
          method: 'POST',
          body: { email, password, displayName },
          auth: false,
        });
        setInfo('Account created. You can sign in now.');
        setMode('signin');
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429)
        setError(`Too many attempts. Try again in ${err.retryAfterSeconds ?? 60} seconds.`);
      else if (err instanceof ApiError && err.status === 401) setError('Email or password is incorrect.');
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-100 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src="/icon.svg" alt="" className="h-11 w-11" />
          <div>
            <p className="text-2xl font-bold tracking-tight">AisleForge</p>
            <p className="text-sm text-slate-600">Retail fulfilment and resilience platform</p>
          </div>
        </div>
        <form
          onSubmit={submit}
          className="card space-y-4 p-6"
          aria-label={mode === 'signin' ? 'Sign in' : 'Create account'}
        >
          <h1 className="text-lg font-semibold">
            {mode === 'signin' ? 'Sign in' : 'Create a customer account'}
          </h1>
          {error && <Alert>{error}</Alert>}
          {info && <Alert tone="green">{info}</Alert>}
          {mode === 'register' && (
            <div>
              <label className="label" htmlFor="displayName">
                Name
              </label>
              <input
                id="displayName"
                className="field"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
          )}
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 12 : 1}
            />
            {mode === 'register' && (
              <p className="mt-1 text-xs text-slate-500">
                At least 12 characters; must not contain your email name.
              </p>
            )}
          </div>
          <Button type="submit" busy={busy} className="w-full">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-slate-600">
            {mode === 'signin' ? 'New customer?' : 'Already have an account?'}{' '}
            <button
              type="button"
              className="font-semibold text-brand-700 hover:underline"
              onClick={() => setMode(mode === 'signin' ? 'register' : 'signin')}
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
