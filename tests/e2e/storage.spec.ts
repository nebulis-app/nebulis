import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

test.describe('Storage Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/storage');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /storage/i })).toBeVisible();
  });

  test('shows all objects in breakdown', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('shows total file sizes', async ({ page }) => {
    // M42: 524288000 bytes formats via formatBytes() as "524.3 MB" (decimal
    // SI units, matching Finder/Disk Utility), not "500.0 MB" (binary).
    await expect(page.getByText('524.3 MB', { exact: true })).toBeVisible();
  });

  test('shows file counts', async ({ page }) => {
    // M42: 45 files, M31: 22 files
    await expect(page.getByText(/45/).first()).toBeVisible();
    await expect(page.getByText(/22/).first()).toBeVisible();
  });

  test('shows sub-frame counts', async ({ page }) => {
    // M42: 30 sub-frames
    await expect(page.getByText(/30/).first()).toBeVisible();
  });

  test('shows disk usage information', async ({ page }) => {
    // System storage: 50% used, 500 GB total, 250 GB free, shown on the disk bar.
    await expect(page.getByText('500 GB total', { exact: true })).toBeVisible();
    await expect(page.getByText('50%', { exact: true })).toBeVisible();
  });

  test('shows free disk space', async ({ page }) => {
    await expect(page.getByText('250 GB free', { exact: true })).toBeVisible();
  });

  test('telescope online status is shown', async ({ page }) => {
    // The status badge lives in the SeeStar section, so scope to that section
    // rather than matching /online/i across the nav, Local Server badge, etc.
    const seestar = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'SeeStar Telescope' }),
    });
    await expect(seestar.getByText('Online', { exact: true })).toBeVisible();
  });

  test('shows oldest and newest file dates', async ({ page }) => {
    await expect(page.getByText(/2024-01-15|2024-03-15|oldest|newest/i).first()).toBeVisible();
  });

  // The telescope table's column headers are clickable <th> sort controls
  // (role columnheader, not button). Default order is Total Size descending;
  // picking a new column sorts it descending, re-clicking the active column
  // flips direction. Row order is read from the object-name links.
  function telescopeTable(page: Page) {
    return page.locator('table').filter({
      has: page.getByRole('columnheader', { name: 'Sub-frames', exact: true }),
    });
  }

  test('should sort by size ascending when the active Total Size header is clicked', async ({ page }) => {
    const table = telescopeTable(page);
    // Default: largest first (M42 524 MB, M31 210 MB)
    await expect(table.getByRole('link')).toHaveText(['Orion Nebula', 'Andromeda Galaxy']);
    await table.getByRole('columnheader', { name: 'Total Size', exact: true }).click();
    await expect(table.getByRole('link')).toHaveText(['Andromeda Galaxy', 'Orion Nebula']);
  });

  test('should sort by name A-Z when the Name header is clicked twice', async ({ page }) => {
    const table = telescopeTable(page);
    const nameHeader = table.getByRole('columnheader', { name: 'Name', exact: true });
    await nameHeader.click(); // new column -> descending (Z-A)
    await expect(table.getByRole('link')).toHaveText(['Orion Nebula', 'Andromeda Galaxy']);
    await nameHeader.click(); // flip -> ascending (A-Z)
    await expect(table.getByRole('link')).toHaveText(['Andromeda Galaxy', 'Orion Nebula']);
  });

  test('should sort by newest file date when the Newest header is clicked', async ({ page }) => {
    const table = telescopeTable(page);
    const newestHeader = table.getByRole('columnheader', { name: 'Newest', exact: true });
    await newestHeader.click(); // descending: M42 2024-03-15 before M31 2024-02-20
    await expect(table.getByRole('link')).toHaveText(['Orion Nebula', 'Andromeda Galaxy']);
    await newestHeader.click(); // ascending
    await expect(table.getByRole('link')).toHaveText(['Andromeda Galaxy', 'Orion Nebula']);
  });

  test('shows data directory path', async ({ page }) => {
    // Exact match selects the path paragraph only; the original `.or(/data dir/i)`
    // also matched the "Data directory" label, resolving the locator to 2 elements.
    await expect(page.getByText('/data', { exact: true })).toBeVisible();
  });

  test('shows total library size', async ({ page }) => {
    // dataDir.sizeFormatted: '700 MB'
    await expect(page.getByText(/700 mb|700mb/i)).toBeVisible();
  });

  test('object rows link to object detail', async ({ page }) => {
    // Both storage tables link an object name to its detail page; the
    // library-storage mock is empty, so only the telescope table row matches.
    await page.getByRole('link', { name: 'Orion Nebula' }).click();
    await expect(page).toHaveURL(/\/object\/M42/);
  });
});
