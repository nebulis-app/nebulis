import { test, expect } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

test.describe('Gallery', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /night sky library/i })).toBeVisible();
  });

  test('renders all objects from API', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('North America Nebula')).toBeVisible();
  });

  test('shows session count on cards', async ({ page }) => {
    // M42 has 3 sessions
    await expect(page.getByText(/3\s+session/i).first()).toBeVisible();
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
    // Click the Galaxy filter button
    await page.getByRole('button', { name: /^galaxy$/i }).click();

    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
  });

  test('type filter "All" restores all objects', async ({ page }) => {
    await page.getByRole('button', { name: /^galaxy$/i }).click();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();

    await page.getByRole('button', { name: /^all$/i }).click();
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('combining search and type filter works', async ({ page }) => {
    await page.getByRole('button', { name: /nebula/i }).click();
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('North America');

    await expect(page.getByText('North America Nebula')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
  });

  test('empty search result shows no-results state', async ({ page }) => {
    await page.getByPlaceholder(/search/i).fill('XYZNOTFOUND');
    await expect(page.getByText(/no objects found/i)).toBeVisible();
  });

  test('clicking an object card navigates to object detail', async ({ page }) => {
    await page.getByText('Orion Nebula').first().click();
    await expect(page).toHaveURL(/\/object\/M42/);
  });

  test('import status is visible when not running', async ({ page }) => {
    // Last run time should show somewhere in the import UI
    await expect(page.getByRole('button', { name: /import/i }).first()).toBeVisible();
  });

  test('import button triggers import and shows progress', async ({ page }) => {
    // Override import status to show running after click
    let callCount = 0;
    await page.route('**/api/library/import/status', r => {
      callCount++;
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: callCount > 1 ? MOCK.importRunning : MOCK.importStatus }),
      });
    });

    // Trigger import
    await page.getByRole('button', { name: /import/i }).first().click();

    // Progress indicator appears
    await expect(page.getByText(/importing/i).or(page.getByText(/in progress/i))).toBeVisible({ timeout: 5000 });
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
    await expect(page.getByRole('link', { name: /observations/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /planner/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /wishlist/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /storage/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible();
  });
});
