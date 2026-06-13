import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Planner Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/planner');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /planner|tonight/i })).toBeVisible();
  });

  test('shows observable targets', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Pleiades')).toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy')).toBeVisible();
  });

  test('shows maximum altitude for each target', async ({ page }) => {
    // M42 maxAlt: 55, M45: 68, M51: 72
    await expect(page.getByText(/55°|55 °/).or(page.getByText('55')).first()).toBeVisible();
  });

  test('shows constellation labels', async ({ page }) => {
    await expect(page.getByText('Orion').first()).toBeVisible();
    await expect(page.getByText('Taurus').first()).toBeVisible();
  });

  test('shows object types', async ({ page }) => {
    await expect(page.getByText('Emission Nebula').first()).toBeVisible();
    await expect(page.getByText('Open Cluster').first()).toBeVisible();
  });

  test('shows magnitude values', async ({ page }) => {
    // M42: 4.0
    await expect(page.getByText(/4\.0|mag.*4/i)).toBeVisible();
  });

  test('in-library indicator shown for M42', async ({ page }) => {
    // M42 isInLibrary: true — should show a checkmark or "in library" badge.
    // Previously wrapped in `.catch(() => expect(locator).toBeTruthy())`,
    // which always passed because Playwright Locators are truthy objects.
    await expect(
      page.locator('[title*="library"], [aria-label*="library"]')
        .or(page.getByText(/in library/i))
        .or(page.locator('svg[class*="check"]').first()),
    ).toBeVisible({ timeout: 3000 });
  });

  test('in-wishlist indicator shown for Pleiades', async ({ page }) => {
    // M45 isInWishlist: true. Same swallow-catch fix as above.
    await expect(
      page.locator('[title*="wishlist"], [aria-label*="wishlist"]')
        .or(page.getByText(/wishlist/i)),
    ).toBeVisible({ timeout: 3000 });
  });

  test('type filter works', async ({ page }) => {
    // Was gated on `if (await galaxyFilter.isVisible())` so the test passed
    // with zero assertions whenever the button was missing. Now it requires
    // the filter UI to exist, which is the whole point of the test.
    const galaxyFilter = page.getByRole('button', { name: /^galaxy$/i });
    await expect(galaxyFilter).toBeVisible();
    await galaxyFilter.click();
    await expect(page.getByText('Whirlpool Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('sorting by name works', async ({ page }) => {
    const sortByName = page.getByRole('button', { name: /name/i });
    await expect(sortByName).toBeVisible();
    await sortByName.click();
    // Verify the *order* — Orion Nebula must precede Whirlpool Galaxy
    // alphabetically. Previously only asserted `names.length > 0`, which
    // would have passed even if sorting was a no-op.
    const names = await page.getByText(/Orion Nebula|Pleiades|Whirlpool Galaxy/).allTextContents();
    const orionIdx = names.findIndex(n => /Orion Nebula/.test(n));
    const whirlpoolIdx = names.findIndex(n => /Whirlpool Galaxy/.test(n));
    expect(orionIdx).toBeGreaterThanOrEqual(0);
    expect(whirlpoolIdx).toBeGreaterThanOrEqual(0);
    expect(orionIdx).toBeLessThan(whirlpoolIdx);
  });

  test('sorting by altitude works', async ({ page }) => {
    const sortByAlt = page.getByRole('button', { name: /altitude|alt/i });
    await expect(sortByAlt).toBeVisible();
    await sortByAlt.click();
    // M51 maxAlt 72 > M45 68 > M42 55 — so M51 should appear before M45 in
    // a descending-altitude sort. Asserting position (not just visibility)
    // means a sort regression actually fails.
    const order = await page.getByText(/Orion Nebula|Pleiades|Whirlpool Galaxy/).allTextContents();
    const whirlpoolIdx = order.findIndex(n => /Whirlpool Galaxy/.test(n));
    const pleiadesIdx  = order.findIndex(n => /Pleiades/.test(n));
    expect(whirlpoolIdx).toBeGreaterThanOrEqual(0);
    expect(pleiadesIdx).toBeGreaterThanOrEqual(0);
    expect(whirlpoolIdx).toBeLessThan(pleiadesIdx);
  });

  test('add to wishlist works for non-wishlisted target', async ({ page }) => {
    // M51 isInWishlist: false — clicking its add button must POST /api/wishlist.
    let wishlistPostCalled = false;
    await page.route('**/api/wishlist', async r => {
      if (r.request().method() === 'POST') {
        wishlistPostCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: [...MOCK.wishlist] }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist }),
        });
      }
    });

    const galaxyRow = page.getByText('Whirlpool Galaxy').locator('..').locator('..');
    const addBtn = galaxyRow.getByRole('button').filter({ has: page.locator('svg') }).first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    // Previously: `expect(wishlistPostCalled || page.getByText(...)).toBeTruthy()`
    // — both sides of the `||` were truthy regardless of behavior. Now the
    // assertion checks the POST was actually made.
    await expect.poll(() => wishlistPostCalled, { timeout: 3000 }).toBe(true);
  });

  test('remove from wishlist works for wishlisted target', async ({ page }) => {
    let wishlistDeleteCalled = false;
    await page.route('**/api/wishlist/object/**', r => {
      wishlistDeleteCalled = true;
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { deleted: true } }),
      });
    });

    // M45 isInWishlist: true — clicking its remove button must DELETE the
    // wishlist row. Previously had no assertion at all.
    const pleiadesRow = page.getByText('Pleiades').locator('..').locator('..');
    const removeBtn = pleiadesRow.getByRole('button').filter({ has: page.locator('svg') }).first();
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();
    await expect.poll(() => wishlistDeleteCalled, { timeout: 3000 }).toBe(true);
  });

  test('altitude curve expands on target click', async ({ page }) => {
    const m42Row = page.getByText('Orion Nebula').locator('..').locator('..');
    const expandBtn = m42Row.getByRole('button').first();
    await expect(expandBtn).toBeVisible();
    await expandBtn.click();
    await expect(page.getByText(/transit|rise|set|altitude curve/i)).toBeVisible({ timeout: 3000 });
  });

  test('observer location required message shown if not set', async ({ page }) => {
    // Override settings to have no location
    await page.route('**/api/settings', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { ...MOCK.settings, latitude: null, longitude: null } }),
      }));
    await page.goto('/planner');
    // Should prompt to set location or show a warning
    await expect(
      page.getByText(/location|latitude|configure/i)
    ).toBeVisible({ timeout: 5000 });
  });

  test('shows rise and set times', async ({ page }) => {
    await expect(page.getByText(/rise|set|transit/i)).toBeVisible();
  });
});
