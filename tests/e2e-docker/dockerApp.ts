/**
 * Shared bits for the Docker browser specs: sign in to the container's Nebulis and open the app past its one-time popups.
 * Container work (reset, copy a folder in, shell) is tests/lab/labStack.ts, shared with the tier 3 API tests.
 */
import { expect, type Page } from '@playwright/test';

export const API = 'http://localhost:18080/api';
const USER = { username: 'labadmin', password: 'lab-password-123' };

/** Sign in (or register the first user of a fresh app) and mark the running version as seen. */
export async function signIn(): Promise<string> {
  const status = await (await fetch(`${API}/auth/status`)).json() as { data: { requiresSetup: boolean } };
  const res = status.data.requiresSetup
    ? await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...USER, displayName: 'Lab Admin' }) })
    : await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER) });
  const token = ((await res.json()) as { data?: { token?: string } }).data?.token;
  if (!token) throw new Error('could not sign in to the Docker lab');
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const version = ((await (await fetch(`${API}/meta/version`, { headers })).json()) as { data: { version: string } }).data.version;
  await fetch(`${API}/preferences/last-seen-version`, { method: 'PUT', headers, body: JSON.stringify({ version }) });
  return token;
}

/** Open the app signed in, past the tour and the support ask. */
export async function openApp(page: Page, token: string, path = '/'): Promise<void> {
  await page.addInitScript(t => {
    window.localStorage.setItem('nebulis_auth_token', t);
    window.localStorage.setItem('nebulis-tour-seen', '1');
    window.localStorage.setItem('nebulis_support_ask_seen', '2026-01-01T00:00:00.000Z');
  }, token);
  await page.goto(path);
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 1500 }).catch(() => { /* tour not shown */ });
  await expect(page.locator('body')).toBeVisible();
}
