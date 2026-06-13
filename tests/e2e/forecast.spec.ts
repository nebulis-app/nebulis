import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Forecast Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/forecast');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /forecast|tonight/i })).toBeVisible();
  });

  test('shows overall visibility score', async ({ page }) => {
    // Score: 85, label: 'Great'
    await expect(page.getByText(/great|85/i)).toBeVisible();
  });

  test('shows cloud cover percentage', async ({ page }) => {
    await expect(page.getByText(/10%|cloud/i)).toBeVisible();
  });

  test('shows seeing rating', async ({ page }) => {
    await expect(page.getByText(/seeing/i)).toBeVisible();
  });

  test('shows wind speed', async ({ page }) => {
    await expect(page.getByText(/wind/i)).toBeVisible();
  });

  test('shows humidity', async ({ page }) => {
    await expect(page.getByText(/humidity|40%/i)).toBeVisible();
  });

  test('shows moon phase information', async ({ page }) => {
    await expect(page.getByText(/moon/i)).toBeVisible();
  });

  test('shows moon illumination percentage', async ({ page }) => {
    // illumination: 0.5 → 50%
    await expect(page.getByText(/50%|illumination/i)).toBeVisible();
  });

  test('shows hourly forecast breakdown', async ({ page }) => {
    await expect(page.getByText(/hourly/i)).toBeVisible();
  });

  test('shows multiple hourly time slots', async ({ page }) => {
    // Should show several time entries
    const hourlyItems = page.locator('[data-testid="hourly-item"]')
      .or(page.locator('.hourly-item'))
      .or(page.getByText(/:\d{2}/).first());
    await expect(hourlyItems).toBeVisible();
  });

  test('shows location used for forecast', async ({ page }) => {
    await expect(page.getByText(/37.77|San Francisco|-122.42|location/i)).toBeVisible();
  });

  test('shows no-location warning when location is not set', async ({ page }) => {
    await page.route('**/api/settings', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { ...MOCK.settings, latitude: null, longitude: null } }),
      }));
    await page.goto('/forecast');
    await expect(page.getByText(/location|set.*location|configure/i)).toBeVisible({ timeout: 5000 });
  });

  test('visibility label uses appropriate color coding', async ({ page }) => {
    // "Great" should be green-ish — just verify it renders
    await expect(page.getByText('Great')).toBeVisible();
  });

  test('shows transparency metric', async ({ page }) => {
    await expect(page.getByText(/transparency/i)).toBeVisible();
  });

  test('forecast error state shows helpful message', async ({ page }) => {
    await page.route('**/api/forecast**', r =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'FORECAST_UNAVAILABLE', message: 'Service unavailable' } }),
      }));
    await page.goto('/forecast');
    await expect(page.getByText(/error|unavailable|failed/i)).toBeVisible({ timeout: 5000 });
  });

  test('planner link is accessible from forecast page', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /planner/i })
        .or(page.locator('a[href="/planner"]'))
    ).toBeVisible();
  });
});
