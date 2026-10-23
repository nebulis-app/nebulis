/**
 * Top nav sizing. The strip sits between the logo and the right-hand cluster,
 * so whether its labels fit at full size is a question about the room those two
 * leave, not about how many items are turned on. These tests pin that: the same
 * items render full size on a wide screen and compact on a narrow one.
 *
 * Regression notes, each covered below:
 *  - sizing used to be `visibleNavItems.length > 8`, which shrank the bar on a
 *    2560px screen that had room to spare.
 *  - the strip used to be judged against the room mirrored about the bar's
 *    centre. The logo is ~120px and the status cluster ~250px, so half the gap
 *    went unused and full-size labels rendered compact at 1470px even though
 *    they fit with room to spare.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

const ALL_NAV_IDS = [
  'library', 'gallery', 'observations', 'forecast', 'planner',
  'wishlist', 'explore', 'catalogs', 'calibrations', 'settings', 'help',
];

/** Nine items, every one except Calibrations and Explore. This is not the shipped default
 *  set (Forecast is off by default too); it is the width the "full size in the
 *  gap" case below was measured and tuned against, so it is pinned here on
 *  purpose. Changing which nine ids these are means re-checking that test's
 *  1470px expectations. */
const DEFAULT_NAV_IDS = ALL_NAV_IDS.filter(id => id !== 'calibrations' && id !== 'explore');

/** Turn every nav item in `ids` on. `settings` is always visible regardless;
 *  the seeded keys mark each hidden-by-default item's one-time default as
 *  already applied (and Wishlist's flipped default as already seen), so the
 *  explicit `nebulis-nav-hidden` list below is what decides. Without them
 *  `applyDefaultSeeds` would force its own defaults over this list. Items
 *  missing from `nebulis-nav-order` are appended by useNavVisibility, so the
 *  hidden list is what actually removes one. */
async function seedNavItems(page: Page, ids: string[] = ALL_NAV_IDS) {
  await page.addInitScript(({ ids, allIds }) => {
    localStorage.setItem('nebulis-nav-order', JSON.stringify(ids));
    localStorage.setItem('nebulis-nav-hidden', JSON.stringify(allIds.filter(id => !ids.includes(id))));
    localStorage.setItem('nebulis-nav-forecast-default-seeded-v1', '1');
    localStorage.setItem('nebulis-nav-calibrations-default-seeded-v1', '1');
    localStorage.setItem('nebulis-nav-wishlist-default-visible-v1', '1');
    localStorage.setItem('nebulis-tour-seen-v1', '1');
  }, { ids, allIds: ALL_NAV_IDS });
}

interface NavMetrics {
  items: number;
  fontSize: number;
  /** Positive means the strip has crossed into the logo (left) or the
   *  right-hand cluster (right). */
  overlapLeft: number;
  overlapRight: number;
}

async function navMetrics(page: Page): Promise<NavMetrics> {
  return page.locator('nav.app-nav').evaluate(() => {
    const bar = document.querySelector('nav.app-nav div.relative.flex.items-center') as HTMLElement;
    const strip = Array.from(bar.children).find(
      el => (el as HTMLElement).className.includes('left-1/2'),
    ) as HTMLElement;
    const logo = bar.querySelector('a') as HTMLElement;
    const right = bar.lastElementChild as HTMLElement;
    const stripRect = strip.getBoundingClientRect();
    return {
      items: strip.querySelectorAll('a').length,
      fontSize: parseFloat(getComputedStyle(strip.querySelector('a') as HTMLElement).fontSize),
      overlapLeft: Math.round(logo.getBoundingClientRect().right - stripRect.left),
      overlapRight: Math.round(stripRect.right - right.getBoundingClientRect().left),
    };
  });
}

test.describe('Top nav sizing', () => {
  test('keeps full-size labels when the bar has room for them', async ({ page }) => {
    await seedNavItems(page);
    await mockAllRoutes(page);
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.goto('/planner');

    const metrics = await navMetrics(page);
    expect(metrics.items).toBe(ALL_NAV_IDS.length);
    // text-sm, not the compact text-xs.
    expect(metrics.fontSize).toBe(14);
    expect(metrics.overlapLeft).toBeLessThan(0);
    expect(metrics.overlapRight).toBeLessThan(0);
  });

  test('tightens the same items when there is not room', async ({ page }) => {
    await seedNavItems(page);
    await mockAllRoutes(page);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/planner');

    // The first commit renders at full size and the layout effect corrects it
    // before paint, so poll rather than read once.
    await expect.poll(async () => (await navMetrics(page)).fontSize).toBe(12);
    expect((await navMetrics(page)).items).toBe(ALL_NAV_IDS.length);
  });

  test('stays full size when the labels fit the gap, even off-centre', async ({ page }) => {
    // 1470px laptop window, default nav set: the labels fit between the logo
    // and the status cluster with ~80px to spare, but they do not fit the room
    // mirrored about the bar's centre (the cluster is twice the logo's width).
    // Measuring against the mirrored room made this render compact.
    await seedNavItems(page, DEFAULT_NAV_IDS);
    await mockAllRoutes(page);
    await page.setViewportSize({ width: 1470, height: 900 });
    await page.goto('/planner');

    await expect.poll(async () => (await navMetrics(page)).fontSize).toBe(14);
    const metrics = await navMetrics(page);
    expect(metrics.items).toBe(DEFAULT_NAV_IDS.length);
    // Full size has to clear both neighbours, so it slides off centre rather
    // than overlapping the cluster it does not fit against symmetrically.
    expect(metrics.overlapLeft).toBeLessThan(-12);
    expect(metrics.overlapRight).toBeLessThan(0);
  });

  test('a compact strip slides clear of the cluster instead of overlapping it', async ({ page }) => {
    // Wide enough for the compact labels to fit the gap, too narrow for that
    // gap to be split evenly around the bar's centre. Every item is on here
    // (eleven, including the two that are off by default), which needs about
    // 40px more than the ten it was first tuned against: 1400px overlaps the
    // status cluster, 1440px clears it.
    await seedNavItems(page);
    await mockAllRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/planner');

    await expect.poll(async () => (await navMetrics(page)).fontSize).toBe(12);
    const metrics = await navMetrics(page);
    expect(metrics.overlapLeft).toBeLessThan(0);
    expect(metrics.overlapRight).toBeLessThan(0);
  });
});
