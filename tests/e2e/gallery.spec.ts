import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Gallery', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('shows page heading', async ({ page }) => {
    // The library hero's title is the i18n `libraryHero.title` string, "Library".
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  });

  test('renders all objects from API', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('North America Nebula')).toBeVisible();
  });

  test('shows session count on cards', async ({ page }) => {
    // Cards render the observation count (objectCard.observationCount), not
    // "sessions". M42 has 3 observations.
    await expect(page.getByRole('link', { name: /Orion Nebula.*3 observations/i })).toBeVisible();
  });

  test('shows type labels on cards', async ({ page }) => {
    await expect(page.getByText('Emission Nebula').first()).toBeVisible();
    await expect(page.getByText('Galaxy').first()).toBeVisible();
  });

  test('search filters objects by name', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('orion');

    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
  });

  test('search filters by catalog ID', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('M31');

    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('search filters by constellation', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('Cygnus');

    await expect(page.getByText('North America Nebula')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('clearing search restores all objects', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('orion');
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();

    await searchInput.clear();
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('type filter shows only matching objects', async ({ page }) => {
    // Type filters live in the Filters popover; pills carry a count suffix.
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: /^galaxy\b/i }).click();

    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
  });

  test('type filter "All" restores all objects', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: /^galaxy\b/i }).click();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();

    await page.getByRole('button', { name: /^all$/i }).click();
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('combining search and type filter works', async ({ page }) => {
    // Anchor the name: with the full curated group set, /nebula/i would also
    // match the "Planetary Nebula" chip.
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: /^nebula\b/i }).click();
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('North America');

    await expect(page.getByText('North America Nebula')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
  });

  test('empty search result shows no-results state', async ({ page }) => {
    await page.getByPlaceholder(/search/i).fill('XYZNOTFOUND');
    // gallery.noSearchMatches: "No objects match your search".
    await expect(page.getByText(/no objects match your search/i)).toBeVisible();
  });

  test('clicking an object card navigates to object detail', async ({ page }) => {
    await page.getByText('Orion Nebula').first().click();
    await expect(page).toHaveURL(/\/object\/M42/);
  });

  test('import status is visible when not running', async ({ page }) => {
    // Import status moved off the Library page: triggering a sync and reporting
    // its progress both live in the telescope pill's dropdown in the top nav
    // (Layout.tsx). Idle, the pill reports how many scopes are online.
    await expect(page.getByRole('button', { name: /\d+\/\d+ online/i })).toBeVisible();
  });

  test('import button triggers import and shows progress', async ({ page }) => {
    // The Library page's old "From Telescope" button is gone; the nav pill now
    // owns sync. Report a run in progress only after the POST starts, so the
    // assertion cannot pass on a stale idle poll.
    let syncStarted = false;
    const envelope = (data: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data }),
    });
    await page.route('**/api/library/import/status', r =>
      r.fulfill(envelope(syncStarted ? MOCK.importRunning : MOCK.importStatus)));
    await page.route('**/api/library/import', r => {
      if (r.request().method() === 'POST') {
        syncStarted = true;
        r.fulfill(envelope({ started: true, objectId: null }));
      } else {
        r.fulfill(envelope(MOCK.importStatus));
      }
    });

    // Open the telescope status pill and sync the configured scope.
    await page.getByRole('button', { name: /\d+\/\d+ online/i }).click();
    await page.getByRole('button', { name: /^sync seestar s50$/i }).click();

    // Progress indicator appears: the pill switches to its syncing label.
    await expect(page.getByRole('button', { name: /^syncing\.\.\.$/i })).toBeVisible({ timeout: 5000 });
  });

  test('shows loading state while fetching', async ({ page }) => {
    // Delay the response to catch the loading state
    await page.route('**/api/library/objects', async r => {
      await new Promise(res => setTimeout(res, 200));
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.objects }),
      });
    });
    await page.goto('/');
    // Either a spinner or skeleton should appear briefly
    // We just verify the content loads eventually
    await expect(page.getByText('Orion Nebula')).toBeVisible({ timeout: 5000 });
  });

  test('nav links are rendered', async ({ page }) => {
    // The standalone Storage link is gone (reached directly or from Settings).
    // Forecast and Calibrations are hidden by default, so they are not part of
    // the default nav strip. Wishlist is a tab on Explore, not a nav item.
    await expect(page.getByRole('link', { name: 'Library', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Gallery', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Observations', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Planner', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wishlist', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Catalogs', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Help', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forecast', exact: true })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Calibrations', exact: true })).toBeHidden();
  });
});
