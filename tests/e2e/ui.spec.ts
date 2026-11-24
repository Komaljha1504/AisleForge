/**
 * The customer, supervisor and admin screens, driven through the real UI against the real stack.
 */
import { expect, test } from '@playwright/test';
import { signIn, sql, stack, waitUntil, writeEvidence } from './stack';

test('customer: shop → place order (stock reserved) → order visible → cancel → task cancelled by the worker', async ({
  page,
}) => {
  await signIn(page, stack().accounts.customer);
  await expect(page).toHaveURL(/\/shop$/);
  const before = (
    await sql<{ reserved: number }>(
      `SELECT reserved FROM inventory_balances WHERE store_id = 1 AND sku = 'APPLE-6'`,
    )
  )[0]!.reserved;
  await page.getByRole('button', { name: 'Add one Apples (6 pack)' }).click();
  await page.getByRole('button', { name: 'Add one Apples (6 pack)' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('Order placed')).toBeVisible();
  const after = (
    await sql<{ reserved: number }>(
      `SELECT reserved FROM inventory_balances WHERE store_id = 1 AND sku = 'APPLE-6'`,
    )
  )[0]!.reserved;
  expect(after - before).toBe(2);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My orders' }).click();
  const order = (
    await sql<{ id: string }>(
      `SELECT o.id FROM orders o JOIN users u ON u.id = o.customer_id WHERE u.email = $1 ORDER BY o.created_at DESC LIMIT 1`,
      [stack().accounts.customer],
    )
  )[0]!;
  await page.getByRole('button', { name: new RegExp(order.id.slice(-8)) }).click();
  await expect(page.getByText('APPLE-6')).toBeVisible();
  await waitUntil(
    async () => (await sql('SELECT 1 FROM pick_tasks WHERE order_id = $1', [order.id])).length === 1,
    'task for the new order',
  );
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByTestId('orders')).toContainText('cancelled');
  const task = await waitUntil(
    async () =>
      (
        await sql<{ status: string }>(
          `SELECT status FROM pick_tasks WHERE order_id = $1 AND status = 'cancelled'`,
          [order.id],
        )
      )[0],
    'task cancelled by the order-workflow consumer',
  );
  const released = (
    await sql<{ reserved: number }>(
      `SELECT reserved FROM inventory_balances WHERE store_id = 1 AND sku = 'APPLE-6'`,
    )
  )[0]!.reserved;
  expect(released).toBe(before);
  writeEvidence('e2e-customer-ui', {
    reservedDelta: after - before,
    taskAfterCancel: task.status,
    reservedAfterCancel: released - before,
  });
});

test('supervisor: store overview, inventory restock reaches the ledger', async ({ page }) => {
  await signIn(page, stack().accounts.supervisor);
  await expect(page.getByRole('heading', { name: 'Store overview' })).toBeVisible();
  await page.getByRole('link', { name: 'Inventory' }).click();
  const row = page.locator('tr', { hasText: 'SOAP-LIQ' });
  const before = (
    await sql<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_balances WHERE store_id = 1 AND sku = 'SOAP-LIQ'`,
    )
  )[0]!.on_hand;
  await row.getByRole('button', { name: 'Restock' }).click();
  await page.getByLabel('Units received').fill('7');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(row).toContainText(String(before + 7));
  const ledger = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM inventory_ledger WHERE store_id = 1 AND sku = 'SOAP-LIQ' AND movement = 'restock' AND delta_on_hand = 7`,
  );
  expect(ledger[0]!.n).toBe(1);
});

test('admin: diagnostics show the live worker and Kafka state; dead letters and users pages load', async ({
  page,
}) => {
  await signIn(page, stack().accounts.admin);
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByTestId('worker').first()).toContainText('reporting');
  await expect(page.getByTestId('worker').first()).toContainText('outbox leader');
  await page.getByRole('link', { name: 'Dead letters' }).click();
  await expect(page.getByRole('heading', { name: 'Dead letters' })).toBeVisible();
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('cell', { name: stack().accounts.picker })).toBeVisible();
});
