/**
 * HTTP client. The access token lives in memory only (never in storage); the refresh token is an HttpOnly cookie the
 * page cannot read. 401 → one single-flight refresh (CSRF header required by the API) → retry once.
 * Network failures surface as OfflineError, distinct from server-side errors, so callers can queue or explain.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class OfflineError extends Error {
  constructor() {
    super('You are offline or the server cannot be reached.');
    this.name = 'OfflineError';
  }
}

export interface SessionUser {
  id: string;
  role: 'customer' | 'picker' | 'supervisor' | 'admin';
  storeId: number | null;
}

let accessToken: string | null = null;
let refreshing: Promise<{ accessToken: string; user: SessionUser } | null> | null = null;
let onSignedOut: (() => void) | null = null;

export const setAccessToken = (t: string | null): void => {
  accessToken = t;
};
export const hasAccessToken = (): boolean => accessToken !== null;
export const onSessionLost = (fn: () => void): void => {
  onSignedOut = fn;
};

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new OfflineError();
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON body */
  }
  const ra = Number(res.headers.get('retry-after'));
  return new ApiError(
    res.status,
    body.error?.code ?? `HTTP_${res.status}`,
    body.error?.message ?? res.statusText,
    body.error?.details,
    Number.isFinite(ra) && ra > 0 ? ra : undefined,
  );
}

/** Rotates the refresh cookie and returns a fresh access token; null when there is no valid session. */
export function refreshSession(): Promise<{ accessToken: string; user: SessionUser } | null> {
  refreshing ??= (async () => {
    try {
      const res = await send('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'X-CSRF-Protection': '1' },
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw await toError(res);
      const body = (await res.json()) as { accessToken: string; user: SessionUser };
      accessToken = body.accessToken;
      return body;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = () => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return send(path, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  };
  let res = await doFetch();
  if (res.status === 401 && opts.auth !== false) {
    const refreshed = await refreshSession().catch((e: unknown) => {
      if (e instanceof OfflineError) throw e;
      return null;
    });
    if (!refreshed) {
      accessToken = null;
      onSignedOut?.();
      throw await toError(res);
    }
    res = await doFetch();
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export async function login(
  email: string,
  password: string,
): Promise<{ accessToken: string; user: SessionUser }> {
  const res = await send('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { accessToken: string; user: SessionUser };
  accessToken = body.accessToken;
  return body;
}

export async function logoutServer(): Promise<void> {
  try {
    await send('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Protection': '1' } });
  } finally {
    accessToken = null;
  }
}

export const describeError = (e: unknown): string =>
  e instanceof OfflineError
    ? e.message
    : e instanceof ApiError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
