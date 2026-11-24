/**
 * Real-browser verification of the Phase 3 session design (review item 3 / ADR-005 limitation 5):
 * cookie flags as stored by Chromium, HttpOnly (invisible to page scripts), refresh rotation across reloads,
 * CSRF protection on refresh, and refresh-token reuse detection revoking the whole session family.
 */
import { expect, test } from '@playwright/test';
import { signIn, stack, writeEvidence } from './stack';

test('refresh cookie flags, HttpOnly, rotation on reload, CSRF and reuse detection in a real browser', async ({
  page,
  context,
}) => {
  await signIn(page, stack().accounts.picker);
  const cookie1 = (await context.cookies()).find((c) => c.name === 'af_refresh');
  expect(cookie1).toBeTruthy();
  expect(cookie1).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/v1/auth' });

  // Page JavaScript cannot read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain('af_refresh');

  // Reload: the app restores the session through /auth/refresh, which ROTATES the cookie.
  await page.reload();
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  const cookie2 = (await context.cookies()).find((c) => c.name === 'af_refresh')!;
  expect(cookie2.value).not.toBe(cookie1!.value);

  // CSRF: a refresh without the custom header is refused even from the same origin with the cookie attached.
  const noHeader = await page.evaluate(
    async () => (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })).status,
  );
  expect(noHeader).toBe(403);
  // A cross-origin Origin is refused too (simulated request carrying the real cookie).
  const crossOrigin = await page.request.post('/api/v1/auth/refresh', {
    headers: {
      'X-CSRF-Protection': '1',
      Origin: 'https://evil.example',
      Cookie: `af_refresh=${cookie2.value}`,
    },
  });
  expect(crossOrigin.status()).toBe(403);

  // Reuse detection: presenting the OLD (already rotated) token revokes the whole family …
  const reuse = await page.request.post('/api/v1/auth/refresh', {
    headers: {
      'X-CSRF-Protection': '1',
      Origin: 'http://localhost:4173',
      Cookie: `af_refresh=${cookie1!.value}`,
    },
  });
  expect(reuse.status()).toBe(401);
  // … so the legitimate browser session is signed out at its next refresh.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  writeEvidence('e2e-auth-cookies', {
    cookie: {
      httpOnly: cookie1!.httpOnly,
      secure: cookie1!.secure,
      sameSite: cookie1!.sameSite,
      path: cookie1!.path,
    },
    rotatedOnReload: cookie2.value !== cookie1!.value,
    refreshWithoutCsrfHeader: noHeader,
    refreshFromForeignOrigin: crossOrigin.status(),
    reuseOfRotatedToken: reuse.status(),
    sessionAfterReuse: 'signed out',
  });
});
