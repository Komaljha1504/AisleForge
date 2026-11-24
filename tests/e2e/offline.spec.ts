/**
 * Offline-first picking in a real browser against the real stack (orders → Kafka → worker → pick tasks).
 * Offline is real network emulation (context.setOffline); the app shell comes from the production service worker;
 * a "browser restart" closes and relaunches a persistent Chromium profile.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { apiLogin, orderWithTask, signIn, sql, stack, waitUntil, writeEvidence } from './stack';

const BASE = 'http://localhost:4173';

async function controlledBySW(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

async function claimFromList(page: Page, orderId: string): Promise<void> {
  await page.goto('/tasks');
  const row = page.getByTestId('available-tasks').locator('li', { hasText: orderId.slice(-8) });
  await row.getByRole('button', { name: 'Claim' }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
}

async function pick(page: Page, sku: string, qty?: number): Promise<void> {
  await page.getByLabel('Scan or type SKU').fill(sku);
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  const active = page.getByTestId('active-line');
  await expect(active).toContainText(sku);
  if (qty === undefined) await active.getByRole('button', { name: 'Confirm pick' }).click();
  else {
    await page.getByLabel('Quantity found').fill(String(qty));
    await active.getByRole('button', { name: 'Record short pick' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Record short pick' }).click();
  }
}

const pendingCount = async (page: Page) =>
  Number((await page.getByTestId('pending-count').innerText()).match(/\d+/)![0]);

function invariants(): { invariant: string; status: string }[] {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/database/src/cli/invariants.ts'], {
    env: { ...process.env, DATABASE_URL: stack().databaseUrl },
    encoding: 'utf8',
  });
  return (JSON.parse(r.stdout) as { invariants: { invariant: string; status: string }[] }).invariants;
}

test('offline picking survives a real browser restart and synchronizes exactly once', async ({ request }) => {
  const { orderId, taskId } = await orderWithTask(request, [
    { sku: 'PASTA-500', qty: 2 },
    { sku: 'MILK-1L', qty: 3 },
  ]);
  const profile = mkdtempSync(path.join(os.tmpdir(), 'aisleforge-e2e-profile-'));
  const launch = () => chromium.launchPersistentContext(profile, { baseURL: BASE, serviceWorkers: 'allow' });

  let ctx: BrowserContext = await launch();
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await signIn(page, stack().accounts.picker);
  await controlledBySW(page);
  await claimFromList(page, orderId);

  // ---- offline: pick, short-pick, complete ------------------------------------------------------------------
  await ctx.setOffline(true);
  await expect(page.getByTestId('connection-status')).toContainText('Offline');
  await pick(page, 'PASTA-500');
  await expect(page.getByTestId('line-state-PASTA-500')).toContainText('waiting to sync');
  await pick(page, 'MILK-1L', 1); // short pick: 1 of 3 found
  await expect(page.getByTestId('line-state-MILK-1L')).toContainText('waiting to sync');
  await page.getByRole('button', { name: 'Complete task' }).click();
  await expect(page.getByTestId('completion-state')).toContainText('waiting to sync');
  await expect.poll(() => pendingCount(page)).toBe(3);
  // Nothing reached the server, and nothing claims it did.
  expect(await sql('SELECT 1 FROM sync_ops WHERE task_id = $1', [taskId])).toHaveLength(0);
  expect(
    (await sql<{ status: string }>('SELECT status FROM pick_tasks WHERE id = $1', [taskId]))[0]!.status,
  ).toBe('claimed');

  // ---- browser restart while still offline -------------------------------------------------------------------
  await ctx.close();
  ctx = await launch();
  await ctx.setOffline(true);
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`/tasks/${taskId}`); // served by the service worker; data from IndexedDB
  await expect(page.getByTestId('connection-status')).toContainText(/Offline|Reconnecting/);
  await expect(page.getByTestId('line-state-PASTA-500')).toContainText('waiting to sync');
  await expect(page.getByTestId('completion-state')).toContainText('waiting to sync');
  await expect.poll(() => pendingCount(page)).toBe(3);

  // ---- reconnect: session confirmed with the server, queue uploaded ----------------------------------------
  await ctx.setOffline(false);
  await expect.poll(() => pendingCount(page), { timeout: 60_000 }).toBe(0);
  const ops = await sql<{ op_type: string; status: string }>(
    'SELECT op_type, status FROM sync_ops WHERE task_id = $1 ORDER BY seq',
    [taskId],
  );
  expect(ops).toEqual([
    { op_type: 'pick.confirm', status: 'applied' },
    { op_type: 'pick.confirm', status: 'applied' },
    { op_type: 'task.complete', status: 'applied' },
  ]);
  const order = await waitUntil(
    async () =>
      (
        await sql<{ status: string }>(`SELECT status FROM orders WHERE id = $1 AND status = 'picked'`, [
          orderId,
        ])
      )[0],
    'order picked',
  );
  await expect(page.getByTestId('completion-state')).toContainText('Task completed', { timeout: 30_000 });
  const lines = await sql<{ sku: string; picked_qty: number; short_qty: number }>(
    'SELECT sku, picked_qty, short_qty FROM order_lines WHERE order_id = $1 ORDER BY sku',
    [orderId],
  );
  expect(lines).toEqual([
    { sku: 'MILK-1L', picked_qty: 1, short_qty: 2 },
    { sku: 'PASTA-500', picked_qty: 2, short_qty: 0 },
  ]);
  const inv = invariants();
  expect(inv.map((r) => r.invariant)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7']);
  for (const r of inv) expect(r.status, r.invariant).toBe('PASS');
  writeEvidence('e2e-offline-restart-sync', {
    opsAfterSync: ops,
    orderStatus: order.status,
    lines,
    invariants: inv.map((r) => `${r.invariant}:${r.status}`),
  });
  await ctx.close();
});

test('a task reassigned while the picker was offline: the pick is rejected, shown to picker and supervisor', async ({
  page,
  context,
  request,
}) => {
  const { orderId, taskId } = await orderWithTask(request, [{ sku: 'RICE-2KG', qty: 1 }]);
  await signIn(page, stack().accounts.picker);
  await controlledBySW(page);
  await claimFromList(page, orderId);
  await context.setOffline(true);
  await pick(page, 'RICE-2KG');
  await expect(page.getByTestId('line-state-RICE-2KG')).toContainText('waiting to sync');

  // Meanwhile (server side): the supervisor releases the task and another picker claims it.
  const sup = await apiLogin(request, stack().accounts.supervisor);
  expect(
    (
      await request.post(`/api/v1/pick-tasks/${taskId}/release`, {
        headers: { Authorization: `Bearer ${sup}` },
      })
    ).status(),
  ).toBe(200);
  const p2 = await apiLogin(request, stack().accounts.picker2);
  expect(
    (
      await request.post(`/api/v1/pick-tasks/${taskId}/claim`, { headers: { Authorization: `Bearer ${p2}` } })
    ).status(),
  ).toBe(200);

  await context.setOffline(false);
  await expect(page.getByTestId('line-state-RICE-2KG')).toContainText('rejected', { timeout: 60_000 });
  await expect(page.getByText('This task was reassigned to someone else')).toBeVisible();
  await page.goto('/sync');
  await expect(page.getByText('This task was reassigned to someone else').first()).toBeVisible();
  // The supervisor's review queue has it.
  const queue = await request.get('/api/v1/sync/rejections?status=open', {
    headers: { Authorization: `Bearer ${sup}` },
  });
  const items = ((await queue.json()) as { rejections: { taskId: string; reason: string }[] }).rejections;
  expect(items.some((r) => r.taskId === taskId && r.reason === 'task_not_assigned_to_you')).toBe(true);
  // Stock stays reserved for the new picker (the rejected pick changed nothing).
  const res = await sql<{ status: string }>(`SELECT status FROM reservations WHERE order_id = $1`, [orderId]);
  expect(res.map((r) => r.status)).toEqual(['active']);
  writeEvidence('e2e-offline-conflict', { reason: 'task_not_assigned_to_you', reservation: res[0]!.status });
});

test('shared device: queued work stays with its employee and is never sent by another', async ({
  page,
  context,
  request,
}) => {
  const { orderId, taskId } = await orderWithTask(request, [{ sku: 'COFFEE-250', qty: 1 }]);
  await signIn(page, stack().accounts.picker);
  await controlledBySW(page);
  await claimFromList(page, orderId);
  await context.setOffline(true);
  await pick(page, 'COFFEE-250');
  // This device's session (identified by its current refresh cookie) — what signing out here must end.
  const deviceCookie = (await context.cookies()).find((c) => c.name === 'af_refresh')!.value;
  const deviceTokenHash = createHash('sha256').update(deviceCookie).digest('hex');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('dialog')).toContainText('have not reached the server yet');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // Back online: opening the app must NOT resume the signed-out employee's session (their logout could not be sent
  // while offline; it is sent now and revokes their refresh tokens).
  await context.setOffline(false);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('signed-in-as')).toHaveCount(0);
  const revoked = await waitUntil(
    async () =>
      (
        await sql<{ open: number }>(
          `SELECT count(*) FILTER (WHERE t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now())::int AS open
             FROM refresh_tokens t
            WHERE t.family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
          [deviceTokenHash],
        )
      )[0]!.open === 0 || null,
    "this device's session family revoked by the deferred logout",
  );
  expect(revoked).toBe(true);

  // Another employee signs in on the same browser.
  await signIn(page, stack().accounts.picker2);
  await page.goto('/sync');
  await expect(page.getByText('recorded by another employee on this device are held')).toBeVisible();
  await expect(page.getByTestId('sync-pending')).toHaveText('0');
  await page.waitForTimeout(3000);
  expect(await sql('SELECT 1 FROM sync_ops WHERE task_id = $1', [taskId])).toHaveLength(0);

  // The original employee returns: their pick is sent and applied.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, stack().accounts.picker);
  const applied = await waitUntil(
    async () =>
      (await sql<{ status: string }>(`SELECT status FROM sync_ops WHERE task_id = $1`, [taskId]))[0],
    'held op uploaded by its owner',
  );
  expect(applied.status).toBe('applied');
  writeEvidence('e2e-shared-device', {
    heldForOtherEmployee: true,
    appliedAfterOwnerReturned: applied.status,
  });
});

test('two tabs reconnecting at once upload the queue exactly once', async ({ context, request }) => {
  const { orderId, taskId } = await orderWithTask(request, [
    { sku: 'TOMATO-CAN', qty: 1 },
    { sku: 'OLIVE-OIL', qty: 1 },
  ]);
  const a = await context.newPage();
  await signIn(a, stack().accounts.picker);
  await controlledBySW(a);
  await claimFromList(a, orderId);
  const b = await context.newPage();
  await b.goto(`/tasks/${taskId}`);
  await expect(b.getByTestId('signed-in-as')).toBeVisible();
  await context.setOffline(true);
  await pick(a, 'TOMATO-CAN');
  await pick(a, 'OLIVE-OIL');
  await context.setOffline(false); // both tabs receive 'online' and try to synchronize
  await waitUntil(
    async () =>
      (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM sync_ops WHERE task_id = $1`, [taskId]))[0]!
        .n === 2,
    'two ops recorded',
  );
  await a.waitForTimeout(3000);
  const rows = await sql<{ status: string; n: number }>(
    `SELECT status::text, count(*)::int AS n FROM sync_ops WHERE task_id = $1 GROUP BY 1`,
    [taskId],
  );
  expect(rows).toEqual([{ status: 'applied', n: 2 }]);
  await expect(b.getByTestId('line-state-OLIVE-OIL')).toContainText('picked', { timeout: 30_000 });
  writeEvidence('e2e-two-tabs', { syncOps: rows });
});
