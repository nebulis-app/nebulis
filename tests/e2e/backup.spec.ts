import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, MOCK } from './fixtures/mocks';

function ok<T>(data: T) {
  return { ok: true, data };
}

test.describe('Backup Status', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/backup');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /backup status/i })).toBeVisible();
  });

  test('shows back to library link', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /back to library/i })
        .or(page.locator('a[href="/"]').filter({ hasText: /library/i }))
    ).toBeVisible();
  });

  test('back link navigates to gallery', async ({ page }) => {
    await page.getByRole('link', { name: /back to library/i })
      .or(page.locator('a[href="/"]').filter({ hasText: /library/i }))
      .click();
    await expect(page).toHaveURL('/');
  });

  test('shows telescope name', async ({ page }) => {
    await expect(page.getByText('Seestar S50')).toBeVisible();
  });

  test('shows telescope offline status', async ({ page }) => {
    await expect(page.getByText(/offline/i)).toBeVisible();
  });

  test('Sync Now button is present when not running', async ({ page }) => {
    await expect(page.getByRole('button', { name: /sync now/i })).toBeVisible();
  });

  test('Sync Now button is disabled when all telescopes are offline', async ({ page }) => {
    await expect(page.getByRole('button', { name: /sync now/i })).toBeDisabled();
  });

  test('Sync Now button is enabled when a telescope is online', async ({ page }) => {
    await page.route('**/api/telescopes/status/all', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok([{ ...MOCK.allTelescopeStatusList[0], online: true, latencyMs: 12 }])),
      }));
    await page.reload();

    await expect(page.getByRole('button', { name: /sync now/i })).toBeEnabled();
  });

  test('Sync Now calls the import API', async ({ page }) => {
    // Re-mock with an online telescope so the button is enabled
    await page.route('**/api/telescopes/status/all', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok([{ ...MOCK.allTelescopeStatusList[0], online: true, latencyMs: 12 }])),
      }));
    await page.reload();

    const importRequest = page.waitForRequest(
      req => req.url().includes('/api/library/import') && req.method() === 'POST'
    );
    await page.getByRole('button', { name: /sync now/i }).click();
    await importRequest;
  });

  test('shows import history entry', async ({ page }) => {
    await expect(page.getByText('Seestar S50').first()).toBeVisible();
    // History should show the run date
    await expect(page.getByText(/march 15|2024-03-15/i).first()).toBeVisible();
  });
});

// ─── Active sync state ────────────────────────────────────────────────────────

test.describe('Backup Status — running import', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);

    await page.route('**/api/library/import/status', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok(MOCK.importRunning)),
      }));

    await page.goto('/backup');
  });

  test('shows syncing in progress heading', async ({ page }) => {
    await expect(
      page.getByText(/syncing in progress/i)
        .or(page.getByText(/sync/i).filter({ hasText: /progress/i }))
    ).toBeVisible();
  });

  test('shows the current object being imported', async ({ page }) => {
    await expect(page.getByText('M42')).toBeVisible();
  });

  test('shows a progress bar', async ({ page }) => {
    await expect(
      page.locator('[role="progressbar"]')
        .or(page.locator('[class*="progress"]'))
    ).toBeVisible();
  });

  test('Sync Now button is hidden while running', async ({ page }) => {
    await expect(page.getByRole('button', { name: /sync now/i })).not.toBeVisible();
  });
});

// ─── Error state ──────────────────────────────────────────────────────────────

test.describe('Backup Status — error state', () => {
  test('shows error message when last import failed', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/library/import/status', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({
          ...MOCK.importStatus,
          error: 'SMB connection refused',
        })),
      }));
    await page.goto('/backup');

    await expect(page.getByText(/error|failed|refused/i)).toBeVisible();
  });
});
