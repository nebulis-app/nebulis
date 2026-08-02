import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

/**
 * The Observations page's Share action is view-aware: Calendar shares a
 * branded month card, List shares the currently sorted table, and Map shares
 * an actual screenshot of what's on screen. Each view's Share button opens a
 * different modal with content specific to that view — this file checks that
 * routing and each modal's basic contract, not the pixel content of the
 * exported cards (covered visually during development, not worth pinning
 * down to exact canvas output here).
 */

async function mockLocations(page: Page) {
  await page.route('**/api/observations/locations', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(ok([
      { objectId: 'M42', date: '2024-03-15', objectName: 'Orion Nebula', catalogId: 'M42', telescopeId: null, lat: 40.7128, lon: -74.006, source: 'fits' },
    ])),
  }));
}

test.describe('Observations Share', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations');
  });

  test('Calendar view shares a calendar card', async ({ page }) => {
    await page.getByRole('button', { name: /^share$/i }).click();
    await expect(page.getByText('Share Calendar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy as text' })).toBeVisible();
  });

  test('List view shares the table, not the calendar card', async ({ page }) => {
    await page.getByRole('button', { name: 'List' }).click();
    await page.getByRole('button', { name: /^share$/i }).click();

    await expect(page.getByText('Share Observations List')).toBeVisible();
    await expect(page.getByText('Share Calendar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy as text' })).toBeVisible();
  });

  // The sort label is painted onto the share card's <canvas> as pixels, so it
  // isn't visible to getByText. "Copy as text" runs the same buildListShareText
  // code path as a real DOM string, which both proves the copy feature works
  // and lets the sort label be asserted on directly.
  test('List share reflects the table default sort', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'clipboard permissions are chromium-only in Playwright');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.getByRole('button', { name: 'List' }).click();
    await page.getByRole('button', { name: /^share$/i }).click();
    await page.getByRole('button', { name: 'Copy as text' }).click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('Sorted by date, newest first');
  });

  test('List share updates when the table is re-sorted', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'clipboard permissions are chromium-only in Playwright');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.getByRole('button', { name: 'List' }).click();
    // Object column ascending, per ObservationsList's default sort direction for names.
    await page.getByRole('button', { name: 'Object' }).click();
    await page.getByRole('button', { name: /^share$/i }).click();
    await page.getByRole('button', { name: 'Copy as text' }).click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('Sorted by object, A to Z');
  });

  test('Map view hides Share until there are locations to show', async ({ page }) => {
    await page.getByRole('button', { name: 'Map' }).click();
    await expect(page.getByText('No location data yet')).toBeVisible();
    await expect(page.getByRole('button', { name: /^share$/i })).toHaveCount(0);
  });

  test('Map view shares a screenshot once locations are loaded', async ({ page }) => {
    await mockLocations(page);
    await page.getByRole('button', { name: 'Map' }).click();
    await expect(page.getByRole('button', { name: /^share$/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /^share$/i }).click();
    await expect(page.getByText('Share Map')).toBeVisible();
    // No "Copy as text" — a screenshot has no text form, unlike Calendar/List.
    await expect(page.getByRole('button', { name: 'Copy as text' })).toHaveCount(0);

    // Capture resolves against the real tile CDN in this environment; give it
    // room, then expect either a successful preview or the graceful error
    // state — never an unhandled crash of the modal itself.
    await expect(
      page.getByRole('button', { name: 'Save image' }).or(page.getByText("Couldn't capture the map."))
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Done closes the share modal and returns to the page underneath', async ({ page }) => {
    await page.getByRole('button', { name: /^share$/i }).click();
    await expect(page.getByText('Share Calendar')).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Share Calendar')).toHaveCount(0);
    // The view switch is reachable again — the modal was a full-screen
    // overlay, so this also confirms it actually unmounted rather than
    // just visually hiding.
    await expect(page.getByRole('button', { name: 'List' })).toBeVisible();
  });
});
