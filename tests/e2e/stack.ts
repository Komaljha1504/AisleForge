import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const E2E_PASSWORD = 'Forge-demo-Pass-2026!';
export const STACK_FILE = path.join(os.tmpdir(), 'aisleforge-e2e', 'stack.json');
export const API_PORT = 18080;
export const WEB_PORT = 4173;

export interface Stack {
  databaseUrl: string;
  runDir: string;
  password: string;
  prefix: string;
  accounts: { customer: string; picker: string; picker2: string; supervisor: string; admin: string };
}
export const stack = (): Stack => JSON.parse(readFileSync(STACK_FILE, 'utf8')) as Stack;

export async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: stack().databaseUrl });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

export async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(stack().password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
}

/** Bearer token via the real API (used to set up state as other actors: customer orders, supervisor actions). */
export async function apiLogin(request: APIRequestContext, email: string): Promise<string> {
  const r = await request.post('/api/v1/auth/login', { data: { email, password: stack().password } });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

/** Places an order as the demo customer and waits until the worker created its pick task (Kafka path). */
export async function orderWithTask(
  request: APIRequestContext,
  lines: { sku: string; qty: number }[],
): Promise<{ orderId: string; taskId: string }> {
  const token = await apiLogin(request, stack().accounts.customer);
  const r = await request.post('/api/v1/orders', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    data: { storeId: 1, lines },
  });
  expect(r.status()).toBe(201);
  const { orderId } = (await r.json()) as { orderId: string };
  const task = await waitUntil(
    async () => (await sql<{ id: string }>('SELECT id FROM pick_tasks WHERE order_id = $1', [orderId]))[0],
    'pick task created by the worker from Kafka',
  );
  return { orderId, taskId: task.id };
}

export function writeEvidence(name: string, data: unknown): void {
  const root = process.env.AISLEFORGE_EVIDENCE_ROOT ?? path.join('audit', 'test-results');
  const dir = path.resolve(root, 'phase4');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), ...(data as object) }, null, 2));
}
