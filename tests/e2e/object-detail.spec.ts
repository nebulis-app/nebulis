import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Object Detail', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('shows object name', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /orion nebula/i })).toBeVisible();
  });

  test('shows catalog ID', async ({ page }) => {
    await expect(page.getByText('M42')).toBeVisible();
  });

  test('shows object type', async ({ page }) => {
    await expect(page.getByText(/emission nebula/i)).toBeVisible();
  });

  test('shows constellation', async ({ page }) => {
    await expect(page.getByText(/orion/i)).toBeVisible();
  });

  test('shows magnitude', async ({ page }) => {
    await expect(page.getByText(/4\.0|magnitude/i)).toBeVisible();
  });

  test('shows RA/Dec coordinates', async ({ page }) => {
    await expect(page.getByText(/05h 35m/i)).toBeVisible();
  });

  test('shows session list', async ({ page }) => {
    await expect(page.getByText('2024-03-15')).toBeVisible();
    await expect(page.getByText('2024-02-10')).toBeVisible();
  });

  test('sessions show file counts', async ({ page }) => {
    // Sessions have fileCount: 12 and fileCount: 8
    await expect(page.getByText(/12|8/).first()).toBeVisible();
  });

  test('clicking a session navigates to session detail', async ({ page }) => {
    await page.getByText('2024-03-15').first().click();
    await expect(page).toHaveURL(/\/object\/M42\/session\/2024-03-15/);
  });

  test('compare view link is present', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /compare/i })
        .or(page.getByText(/compare/i))
    ).toBeVisible();
  });

  test('back/breadcrumb navigation is present', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /library|gallery|back/i })
        .or(page.locator('a[href="/"]'))
    ).toBeVisible();
  });
});

test.describe('Session Detail', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    // Provide session files
    await page.route('**/api/library/objects/M42/sessions/2024-03-15/files', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.sessionFiles }),
      }));
    await page.goto('/object/M42/session/2024-03-15');
  });

  test('shows object and date in heading', async ({ page }) => {
    await expect(page.getByText(/M42|Orion/i)).toBeVisible();
    await expect(page.getByText(/2024-03-15/)).toBeVisible();
  });

  test('shows stacked FITS file', async ({ page }) => {
    await expect(page.getByText('Stacked_M42_2024-03-15.fit')).toBeVisible();
  });

  test('shows image file', async ({ page }) => {
    await expect(page.getByText('M42_2024-03-15.jpg')).toBeVisible();
  });

  test('shows sub-frame files', async ({ page }) => {
    await expect(page.getByText('sub_001.fit')).toBeVisible();
  });

  test('shows exposure information', async ({ page }) => {
    await expect(page.getByText(/600|exposure/i)).toBeVisible();
  });

  test('file type filter tabs are present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /all/i })
        .or(page.getByText(/^all$/i))
    ).toBeVisible();
  });

  test('download link is present for files', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /download/i })
        .or(page.locator('[aria-label*="download"]'))
        .or(page.locator('[title*="download"]'))
    ).toBeVisible();
  });

  test('sub-frames page link is present', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /sub.?frames|sub-frames/i })
        .or(page.getByText(/sub.?frames/i))
    ).toBeVisible();
  });
});

test.describe('Sub-Frames Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.route('**/api/library/objects/M42/sessions/2024-03-15/files', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.sessionFiles }),
      }));
    await page.goto('/object/M42/session/2024-03-15/subframes');
  });

  test('shows sub-frame file list', async ({ page }) => {
    await expect(page.getByText('sub_001.fit')).toBeVisible();
  });

  test('back navigation to session is present', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /back|session/i })
        .or(page.locator(`a[href*="/object/M42/session/2024-03-15"]`))
    ).toBeVisible();
  });
});
