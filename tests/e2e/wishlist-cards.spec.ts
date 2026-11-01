/**
 * Wishlist card states. An object that is not up tonight used to be a dead end
 * ("Not visible tonight") with the follow-up question ("so when is it?") only
 * answerable by opening the card, so the card now carries the same 12-month
 * max-altitude chart the detail modal shows, at card size.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockAllRoutes, mockWishlist } from './fixtures/mocks';

async function openWishlist(page: Page, width = 1440) {
  await mockAllRoutes(page);
  await mockWishlist(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/explore?tab=wishlist');
  await expect(page.getByRole('tab', { name: /Wishlist/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Orion Nebula')).toBeVisible();
}

function card(page: Page, name: string): Locator {
  // Each card is the clickable tile carrying the object's name.
  return page.locator('div[role="button"]').filter({ hasText: name }).first();
}

/** Bars in the card's month chart, excluding the icons' own SVG shapes. */
function monthBars(scope: Locator): Locator {
  return scope.locator('svg[role="img"] rect');
}

test.describe('Wishlist cards', () => {
  test('an object that is not up tonight shows its month chart', async ({ page }) => {
    await openWishlist(page);

    const off = card(page, 'M94');
    await expect(off.getByText('Not visible tonight')).toBeVisible();
    // The season, spelled out, next to the chart.
    await expect(off.getByText(/^Best: /)).toBeVisible();
    // One bar per month of the year.
    expect(await monthBars(off).count()).toBe(12);
  });

  test('an object that never clears the minimum altitude says so instead of charting', async ({ page }) => {
    await openWishlist(page);

    const never = card(page, 'Tucanae');
    await expect(never.getByText('Not visible tonight')).toBeVisible();
    // It never rises above the horizon from the mock site, so every month's bar
    // would be zero height: an empty box with a dashed line through it. Words.
    await expect(never.getByText(/minimum all year/i)).toBeVisible();
    expect(await monthBars(never).count()).toBe(0);
    await expect(never.getByText(/^Best: /)).toHaveCount(0);
  });

  test('an object that is up tonight keeps its stats and gains no chart', async ({ page }) => {
    await openWishlist(page);

    const up = card(page, 'Orion Nebula');
    await expect(up.getByText('Max alt')).toBeVisible();
    await expect(up.getByText('Window')).toBeVisible();
    await expect(up.getByText('Not visible tonight')).toHaveCount(0);
    expect(await monthBars(up).count()).toBe(0);
  });
});

test.describe('Wishlist tab on Explore', () => {
  test('the old /wishlist link lands on the Wishlist tab', async ({ page }) => {
    await mockAllRoutes(page);
    await mockWishlist(page);
    await page.goto('/wishlist');
    await expect(page).toHaveURL(/\/explore\?tab=wishlist$/);
    await expect(page.getByRole('tab', { name: /Wishlist/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });

  test('Explore opens on Discover and switches tabs in place', async ({ page }) => {
    await mockAllRoutes(page);
    await mockWishlist(page);
    await page.goto('/explore');
    await expect(page.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Browse by kind' })).toBeVisible();

    await page.getByRole('tab', { name: /Wishlist/ }).click();
    await expect(page).toHaveURL(/\/explore\?tab=wishlist$/);
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browse by kind' })).toHaveCount(0);

    // The catalog search stays on screen above both tabs.
    await expect(page.getByRole('combobox', { name: 'Search the sky' })).toBeVisible();

    await page.getByRole('tab', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/explore$/);
  });
});

test.describe('Wishlist toolbar', () => {
  test('Import and Export sit in one menu and "Add to plan" is the only primary button', async ({ page }) => {
    await openWishlist(page);

    // No second row of page-level buttons, and no "Add target": the search is right above.
    await expect(page.getByRole('button', { name: 'Add target' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your wishlist' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /to tonight's plan$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'More wishlist actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Export' })).toBeEnabled();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('the summary line gives the counts on one line', async ({ page }) => {
    await openWishlist(page);
    // The mock list has three targets, one up tonight and one high priority.
    await expect(page.getByText('3 targets, 1 visible tonight \u00b7 1 high priority')).toBeVisible();
  });
});
