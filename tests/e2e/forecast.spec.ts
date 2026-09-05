import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/** Pin an hour on the night ribbon, which opens the hour detail panel. */
async function pickAnHour(page: Page) {
  const ribbon = page.getByRole('group', { name: /hourly sky conditions/i });
  await ribbon.click({ position: { x: 400, y: 120 } });
  return page;
}

test.describe('Forecast Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/forecast');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sky forecast/i })).toBeVisible();
  });

  test('shows tonight rating as the headline', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /^(ideal|great|good|fair|poor|bad)$/i })
    ).toBeVisible();
  });

  test('shows the key times for tonight', async ({ page }) => {
    await expect(page.getByText('Dark hours')).toBeVisible();
    await expect(page.getByText('Sunset')).toBeVisible();
    await expect(page.getByText('Sunrise')).toBeVisible();
    await expect(page.getByText('Best window')).toBeVisible();
  });

  test('shows moon phase and illumination', async ({ page }) => {
    await expect(page.getByText(MOCK.forecast.tonight.moonPhase)).toBeVisible();
    await expect(page.getByText(/50% illuminated/i)).toBeVisible();
  });

  test('renders the night ribbon', async ({ page }) => {
    await expect(page.getByRole('group', { name: /hourly sky conditions/i })).toBeVisible();
    await expect(page.getByRole('img', { name: /tonight's sky conditions/i })).toBeVisible();
  });

  test('night ribbon labels hours across the night', async ({ page }) => {
    const ribbon = page.getByRole('group', { name: /hourly sky conditions/i });
    // Hour labels are SVG text like "7PM" / "1AM" on the rail below the chart.
    await expect(ribbon.locator('text').filter({ hasText: /^\d{1,2}(AM|PM)$/ }).first()).toBeVisible();
  });

  test('picking an hour opens its breakdown', async ({ page }) => {
    await pickAnHour(page);
    // Scoped to the detail panel: "Clouds" also appears on the outlook cards.
    const detail = page.getByRole('region', { name: /conditions at/i });
    await expect(detail.getByText('Clouds')).toBeVisible();
    await expect(detail.getByText('Seeing')).toBeVisible();
    await expect(detail.getByText('Transparency')).toBeVisible();
    await expect(detail.getByText('Moon')).toBeVisible();
    await expect(page.getByRole('button', { name: /close hour detail/i })).toBeVisible();
  });

  test('hour breakdown closes again', async ({ page }) => {
    await pickAnHour(page);
    const close = page.getByRole('button', { name: /close hour detail/i });
    await close.click();
    await expect(close).toBeHidden();
  });

  test('night ribbon is keyboard navigable', async ({ page }) => {
    const ribbon = page.getByRole('group', { name: /hourly sky conditions/i });
    await ribbon.focus();
    await page.keyboard.press('ArrowRight');
    // Stepping with the keyboard selects an hour, which opens the detail panel.
    await expect(page.getByRole('button', { name: /close hour detail/i })).toBeVisible();
  });

  test('shows the nights ahead with wind and humidity', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /nights ahead/i })).toBeVisible();
    await expect(page.getByText('Wind').first()).toBeVisible();
    await expect(page.getByText('Humidity').first()).toBeVisible();
    await expect(page.getByText('Precip').first()).toBeVisible();
  });

  test('does not repeat tonight in the outlook', async ({ page }) => {
    // Tonight owns the hero, so the outlook starts at the next night.
    const cards = page.getByText(/cloud cover through the night/i);
    await expect(cards).toHaveCount(MOCK.forecast.nightRatings.length - 1);
  });

  test('shows the observing site used for the forecast', async ({ page }) => {
    await expect(page.getByText(MOCK.sites[0].name).first()).toBeVisible();
  });

  test('shows the rating legend and data source', async ({ page }) => {
    await expect(page.getByText(/85\+ ideal/i)).toBeVisible();
    await expect(page.getByText(/open-meteo/i)).toBeVisible();
  });

  test('shows no-location warning when the site has no coordinates', async ({ page }) => {
    const siteWithoutCoords = { ...MOCK.sites[0], latitude: null, longitude: null };
    await page.route('**/api/sites', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok([siteWithoutCoords])),
    }));
    await page.route('**/api/sites/active', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok(siteWithoutCoords)),
    }));
    await page.goto('/forecast');
    await expect(page.getByText(/location not set/i)).toBeVisible({ timeout: 5000 });
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
