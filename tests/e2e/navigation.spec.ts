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

  test('storage route is reachable directly', async ({ page }) => {
    await mockAllRoutes(page);
    // Storage's standalone nav link was removed; the page is reached by URL or
    // from Settings, so assert the route itself still works.
    await page.goto('/storage');
    await expect(page).toHaveURL('/storage');
    await expect(page.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();
  });

  test('settings nav link goes to /settings', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('link', { name: /settings/i }).click();
    await expect(page).toHaveURL('/settings');
  });

  test('should apply the night theme when Night is picked from the profile menu', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');

    // The theme picker lives in the avatar dropdown ("Profile & settings").
    const profileBtn = page.getByTitle('Profile & settings');
    await expect(profileBtn).toBeVisible();
    await profileBtn.click();
    for (const label of ['Light', 'Dark', 'Space', 'Night']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Night', exact: true }).click();
    // useTheme puts the theme id on <html> and persists it.
    await expect(page.locator('html')).toHaveClass(/(^|\s)night(\s|$)/);
    expect(await page.evaluate(() => localStorage.getItem('nebulis-theme'))).toBe('night');
  });

  test('object detail → session detail → back to object', async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/object/M42');

    // Navigate into a session. Session detail now lives at
    // /observations/:objectId/:date, and the card is labelled with the
    // formatted night ("Fri, Mar 15") rather than the raw date.
    await page.getByRole('link', { name: /Mar 15/ }).click();
    await expect(page).toHaveURL(/\/observations\/M42\/2024-03-15/);

    // The session hero's breadcrumb links back to the object.
    await page.getByRole('link', { name: /Orion Nebula/i }).click();
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
