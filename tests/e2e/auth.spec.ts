import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, MOCK } from './fixtures/mocks';

// ─── Login modal ──────────────────────────────────────────────────────────────

test.describe('Login modal', () => {
  test.beforeEach(async ({ page }) => {
    // hasUsers=true without a stored token → showLogin=true once authStatus loads.
    // Don't call mockAdminAuth here so no token is present.
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('appears when users exist and no token is stored', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });

  test('shows username and password fields', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    await expect(page.getByLabel(/username/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('sign in button disabled with empty fields', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  test('shows error on wrong password', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();

    await page.route('**/api/auth/login', r =>
      r.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } }),
      }));

    await page.getByLabel(/username/i).fill('baduser');
    await page.getByLabel(/password/i).fill('wrongpass');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText(/invalid|incorrect|wrong|failed/i)).toBeVisible();
  });

  test('successful login dismisses modal and shows app content', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();

    await page.route('**/api/auth/login', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.loginResponse }),
      }));
    await page.route('**/api/auth/me', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.loginResponse.user }),
      }));

    await page.getByLabel(/username/i).fill('testuser');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('heading', { name: /sign in/i })).not.toBeVisible();
    await expect(page.locator('nav')).toBeVisible();
  });
});

// ─── Open access (no users configured) ───────────────────────────────────────

test.describe('Open access mode', () => {
  test('app loads directly when no users are configured', async ({ page }) => {
    // Register mockAllRoutes first, then override authStatus so our
    // hasUsers=false route is the last-registered (and wins in Playwright's LIFO order).
    await mockAllRoutes(page);
    await page.route('**/api/auth/status', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { hasUsers: false, requiresSetup: false } }),
      }));
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /sign in/i })).not.toBeVisible();
    await expect(page.locator('nav')).toBeVisible();
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

test.describe('Logout', () => {
  test('sign out button appears in profile menu when token is present', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');

    // Profile/settings button in the nav has title "Profile & settings"
    await page.locator('button[title="Profile & settings"]').click();

    await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  });

  test('sign out clears token and reloads to login', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');

    await page.locator('button[title="Profile & settings"]').click();

    // After sign-out the page reloads; ensure authStatus says hasUsers=true so login shows
    await page.route('**/api/auth/status', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { hasUsers: true, requiresSetup: false } }),
      }));

    await page.getByRole('button', { name: /sign out/i }).click();

    // After reload the token is gone, so login modal should appear
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });
});
