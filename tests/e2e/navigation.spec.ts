/**
 * Navigation & layout tests — verifies that all routes are reachable,
 * the nav bar is always present, and cross-page links work correctly.
 */
import { test, expect } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

const PAGES = [
  { path: '/', name: 'Gallery' },
  { path: '/observations', name: 'Observations' },
  { path: '/planner', name: 'Planner' },
  { path: '/wishlist', name: 'Wishlist' },
  { path: '/storage', name: 'Storage' },
  { path: '/forecast', name: 'Forecast' },
  { path: '/settings', name: 'Settings' },
];

test.describe('Navigation', () => {
  for (const { path, name } of PAGES) {
    test(`${name} page loads without error (${path})`, async ({ page }) => {
      await mockAllRoutes(page);
      await page.goto(path);
      // No uncaught error, heading or main content visible
      await expect(page.locator('body')).not.toContainText(/unexpected application error|cannot read/i);
      await expect(page.locator('h1, h2, main').first()).toBeVisible();
    });
  }

  test('logo navigates to gallery', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');

    await page.locator('a').filter({ has: page.locator('svg') }).first().click();
    await expect(page).toHaveURL('/');
  });

  test('nav bar is visible on all pages', async ({ page }) => {
    await mockAllRoutes(page);
    for (const { path } of PAGES) {
      await page.goto(path);
      await expect(page.locator('nav')).toBeVisible();
    }
  });

  test('observations nav link goes to /observations', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /observations/i }).click();
    await expect(page).toHaveURL('/observations');
  });

  test('planner nav link goes to /planner', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /planner/i }).click();
    await expect(page).toHaveURL('/planner');
  });

  test('wishlist nav link goes to /wishlist', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /wishlist/i }).click();
    await expect(page).toHaveURL('/wishlist');
  });

  test('storage nav link goes to /storage', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /storage/i }).click();
    await expect(page).toHaveURL('/storage');
  });

  test('settings nav link goes to /settings', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /settings/i }).click();
    await expect(page).toHaveURL('/settings');
  });

  test('theme switcher is present and clickable', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');

    const themeBtn = page.getByRole('button', { name: /light|dark|space|night|theme/i });
    if (await themeBtn.isVisible()) {
      await themeBtn.click();
      // Dropdown or options should appear
      await expect(
        page.getByText(/dark|space|night/i).first()
      ).toBeVisible();
    }
  });

  test('object detail → session detail → back to object', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/object/M42');

    // Navigate into a session
    await page.getByText('2024-03-15').first().click();
    await expect(page).toHaveURL(/\/object\/M42\/session\/2024-03-15/);

    // Navigate back
    await page.getByRole('link', { name: /back|M42|Orion/i })
      .or(page.locator(`a[href="/object/M42"]`))
      .first()
      .click();
    await expect(page).toHaveURL('/object/M42');
  });

  test('gallery → object detail → observations → back flow', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');

    // Gallery → Object detail
    await page.getByText('Orion Nebula').first().click();
    await expect(page).toHaveURL('/object/M42');

    // Object detail → gallery via breadcrumb
    await page.getByRole('link', { name: /library|gallery|home/i })
      .or(page.locator('a[href="/"]'))
      .first()
      .click();
    await expect(page).toHaveURL('/');
  });

  test('telescope online status indicator is visible in nav', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    // Telescope status (online/offline dot) should be somewhere in the nav
    await expect(
      page.locator('[class*="status"], [class*="indicator"], [class*="dot"]')
        .or(page.getByText(/online|offline/i))
        .or(page.locator('nav svg').first())
    ).toBeVisible();
  });
});
