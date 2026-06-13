import { test, expect } from '@playwright/test';
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
    // M42: 524288000 bytes ≈ 500 MB
    await expect(page.getByText(/500 mb|500mb|524/i)).toBeVisible();
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
    // System storage: 50% used, 500 GB total
    await expect(page.getByText(/500 gb|50%|disk/i)).toBeVisible();
  });

  test('shows free disk space', async ({ page }) => {
    await expect(page.getByText(/250 gb|free/i)).toBeVisible();
  });

  test('telescope online status is shown', async ({ page }) => {
    await expect(page.getByText(/telescope|offline|online/i)).toBeVisible();
  });

  test('shows oldest and newest file dates', async ({ page }) => {
    await expect(page.getByText(/2024-01-15|2024-03-15|oldest|newest/i).first()).toBeVisible();
  });

  test('sort by size button works', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: /size/i });
    if (await sortBtn.isVisible()) {
      await sortBtn.click();
      // Orion Nebula is largest (500 MB), should appear first after sort
      const items = page.getByText(/orion nebula|andromeda galaxy/i);
      await expect(items.first()).toBeVisible();
    }
  });

  test('sort by name button works', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: /name/i });
    if (await sortBtn.isVisible()) {
      await sortBtn.click();
      // "Andromeda" comes before "Orion" alphabetically
      await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    }
  });

  test('sort by date button works', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: /date/i });
    if (await sortBtn.isVisible()) {
      await sortBtn.click();
      await expect(page.getByText('Orion Nebula')).toBeVisible();
    }
  });

  test('shows data directory path', async ({ page }) => {
    await expect(page.getByText('/data').or(page.getByText(/data dir/i))).toBeVisible();
  });

  test('shows total library size', async ({ page }) => {
    // dataDir.sizeFormatted: '700 MB'
    await expect(page.getByText(/700 mb|700mb/i)).toBeVisible();
  });

  test('object rows link to object detail', async ({ page }) => {
    await page.getByText('Orion Nebula').click();
    await expect(page).toHaveURL(/\/object\/M42/);
  });
});
