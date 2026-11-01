import { test, expect } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

const SEEN_KEY = 'nebulis_support_ask_seen';

test.describe('"Enjoying Nebulis?" support ask', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    // mockAllRoutes marks the ask as seen so other specs are not interrupted; undo that here.
    await page.addInitScript(key => {
      if (!window.sessionStorage.getItem('support-ask-spec-cleared')) {
        window.localStorage.removeItem(key);
        window.sessionStorage.setItem('support-ask-spec-cleared', '1');
      }
    }, SEEN_KEY);
  });

  test('appears on load with the free-forever message, the QR code and the coffee link', async ({ page }) => {
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
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /enjoying nebulis\?/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(key => window.localStorage.getItem(key), SEEN_KEY)).not.toBeNull();

    await page.reload();
    await page.waitForTimeout(2500);
    await expect(page.getByRole('dialog', { name: /enjoying nebulis\?/i })).toHaveCount(0);
  });

  test('the Close button also records it', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /enjoying nebulis\?/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: /^close$/i }).last().click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(key => window.localStorage.getItem(key), SEEN_KEY)).not.toBeNull();
  });
});
