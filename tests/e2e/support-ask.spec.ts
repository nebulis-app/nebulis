import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

const SEEN_KEY = 'nebulis_support_ask_seen';

/** The server's record of the ask, as a stateful stand-in: GET reads it, PUT sets it once. */
async function mockServerRecord(page: Page, initial: string | null) {
  const record = { seenAt: initial, puts: 0 };
  await page.route('**/api/preferences/support-ask', async route => {
    if (route.request().method() === 'PUT') {
      record.puts++;
      record.seenAt ??= '2026-11-02T23:31:00.000Z';
    }
    await route.fulfill({ json: { ok: true, data: { seenAt: record.seenAt } } });
  });
  return record;
}

test.describe('"Enjoying Nebulis?" support ask', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('appears on load with the free-forever message, the QR code and the coffee link', async ({ page }) => {
    await mockServerRecord(page, null);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /enjoying nebulis\?/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(/free, and I intend to keep it that way/i)).toBeVisible();
    await expect(dialog.getByText(/app store/i)).toBeVisible();
    await expect(dialog.getByRole('img', { name: /qr code/i })).toBeVisible();
    const coffee = dialog.getByRole('link', { name: /buy me a coffee/i });
    await expect(coffee).toHaveAttribute('href', 'https://buymeacoffee.com/brent873');
    await expect(coffee).toHaveAttribute('target', '_blank');
    await expect(coffee).toHaveAttribute('rel', /noopener/);
  });

  test('closing it once means it is gone for good, however it was closed', async ({ page }) => {
    const record = await mockServerRecord(page, null);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /enjoying nebulis\?/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect.poll(() => record.puts).toBe(1);
    expect(record.seenAt).not.toBeNull();
    expect(await page.evaluate(key => window.localStorage.getItem(key), SEEN_KEY)).not.toBeNull();

    await page.reload();
    await page.waitForTimeout(2500);
    await expect(page.getByRole('dialog', { name: /enjoying nebulis\?/i })).toHaveCount(0);
  });

  test('the Close button also records it', async ({ page }) => {
    const record = await mockServerRecord(page, null);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /enjoying nebulis\?/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: /^close$/i }).last().click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => record.puts).toBe(1);
    expect(await page.evaluate(key => window.localStorage.getItem(key), SEEN_KEY)).not.toBeNull();
  });

  test('dismissed from another browser: the server remembers, so this one never asks', async ({ page }) => {
    const record = await mockServerRecord(page, '2026-10-30T12:00:00.000Z');
    await page.goto('/');
    await page.waitForTimeout(2500);
    await expect(page.getByRole('dialog', { name: /enjoying nebulis\?/i })).toHaveCount(0);
    expect(record.puts).toBe(0);
  });

  test('dismissed here before the server kept the record: no ask, and the server is told', async ({ page }) => {
    await page.addInitScript(key => window.localStorage.setItem(key, '2026-10-30T12:00:00.000Z'), SEEN_KEY);
    const record = await mockServerRecord(page, null);
    await page.goto('/');
    await expect.poll(() => record.puts, { timeout: 10_000 }).toBe(1);
    await expect(page.getByRole('dialog', { name: /enjoying nebulis\?/i })).toHaveCount(0);
  });
});
