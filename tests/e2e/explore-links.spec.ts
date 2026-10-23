/**
 * The Planner, Explore and the Wishlist agree on what "best tonight" is, and link to one another:
 *  - the Planner's target list defaults to the shared "Best tonight" order (the server's `tonightRank`), with
 *    "Best conditions" (the planner score alone) as the alternative;
 *  - the Planner sends its selected night to Explore, which shows what is up on that night;
 *  - Explore sends an object (and the night) back to the Planner;
 *  - a wishlist card links to the Planner and to the Explore tile it belongs to.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockWishlist, json, ok, MOCK } from './fixtures/mocks';

const base = MOCK.plannerTargets[0];
// Three named targets whose two orders disagree: the highest-scoring one is the least rewarding.
const A = { ...base, id: 'AAA1', name: 'Alpha Target', commonNames: ['Alpha Target'], isAlreadyImaged: false, bestTonightScore: 0.9, showpiece: 5, tonightRank: 0.5 };
const B = { ...base, id: 'BBB2', name: 'Bravo Target', commonNames: ['Bravo Target'], isAlreadyImaged: false, bestTonightScore: 0.5, showpiece: 95, tonightRank: 0.9 };
const C = { ...base, id: 'CCC3', name: 'Charlie Target', commonNames: ['Charlie Target'], isAlreadyImaged: false, bestTonightScore: 0.6, showpiece: 60, tonightRank: 0.7 };

async function openPlanner(page: Page) {
  await mockAllRoutes(page);
  await page.route('**/api/planner/tonight**', r => {
    const now = Date.now();
    const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();
    return r.fulfill(json(ok({
      locationSet: true, targets: [A, B, C], totalVisible: 3, nightStart: iso(-1), nightEnd: iso(8), sunset: iso(-2), sunrise: iso(9),
      timelineStart: iso(-2), timelineEnd: iso(9), moonIllumination: 42, moonPhase: 'Waxing Crescent',
      observerLat: 37.77, observerLon: -122.42, observerTimezone: 'America/Los_Angeles',
    })));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/planner');
}

/** The target names in the order the Planner lists them. */
async function listed(page: Page): Promise<string[]> {
  const text = await page.getByText(/(Alpha|Bravo|Charlie) Target/).allInnerTexts();
  return text.map(t => /(Alpha|Bravo|Charlie)/.exec(t)?.[1] ?? t);
}

test.describe('One definition of best tonight', () => {
  test('the Planner lists targets in the shared Best tonight order, and Best conditions is one click away', async ({ page }) => {
    await openPlanner(page);
    const chooseOrder = async (name: string) => {
      await page.getByRole('button', { name: 'View options', exact: true }).click();
      await page.getByRole('menuitemradio', { name }).click();
    };
    const orderIs = async (name: string) => {
      await page.getByRole('button', { name: 'View options', exact: true }).click();
      await expect(page.getByRole('menuitemradio', { name })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    };
    await orderIs('Best tonight');
    await expect.poll(() => listed(page)).toEqual(['Bravo', 'Charlie', 'Alpha']);

    await chooseOrder('Best conditions');
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);

    // The choice is remembered.
    await page.reload();
    await orderIs('Best conditions');
  });

  test('an older server that sends neither field keeps its own order', async ({ page }) => {
    await mockAllRoutes(page);
    const plain = [A, B, C].map(target => {
      const copy: Record<string, unknown> = { ...target };
      for (const key of ['tonightRank', 'showpiece', 'bestTonightScore']) delete copy[key];
      return copy;
    });
    await page.route('**/api/planner/tonight**', r => {
      const now = Date.now();
      const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();
      return r.fulfill(json(ok({
        locationSet: true, targets: plain, totalVisible: 3, nightStart: iso(-1), nightEnd: iso(8), sunset: iso(-2), sunrise: iso(9),
        timelineStart: iso(-2), timelineEnd: iso(9), moonIllumination: 42, moonPhase: 'x', observerLat: 37.77, observerLon: -122.42, observerTimezone: 'America/Los_Angeles',
      })));
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/planner');
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

test.describe('Planner and Explore link both ways', () => {
  test('the Explore button sends the Planner\'s night, and Explore asks the server about that night', async ({ page }) => {
    // The Planner rolls to a new night at 07:00 in the site's timezone (Los Angeles here), Explore at 07:00 in the
    // browser's. A fixed early-afternoon UTC time keeps both on the same date wherever and whenever this runs.
    await page.clock.setFixedTime(new Date('2026-10-22T20:00:00Z'));
    await openPlanner(page);
    const requests: string[] = [];
    await page.route('**/api/explore/**', r => {
      requests.push(r.request().url());
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/browse')) return r.fulfill(json(ok({ results: [], total: 0, locationSet: true })));
      if (path.endsWith('/categories')) return r.fulfill(json(ok({ locationSet: true, siteId: 's', siteName: 'Home', categories: [] })));
      return r.fulfill(json(ok({ results: [], locationSet: true })));
    });
    await page.getByRole('button', { name: 'Find more targets for this night in Explore' }).click();

    await expect(page).toHaveURL(/\/explore\/all\?visibility=tonight&sort=tonight&night=\d{4}-\d{2}-\d{2}$/);
    const night = new URL(page.url()).searchParams.get('night');
    await expect.poll(() => requests.some(u => u.includes('/browse') && u.includes(`date=${night}`))).toBe(true);
    // The Planner was on tonight, so there is no "another night" banner to show.
    await expect(page.getByText(/Showing .*, the night chosen in the Planner\./)).toHaveCount(0);
  });

  test('another night is said out loud in Explore, with a way back to tonight', async ({ page }) => {
    await mockAllRoutes(page);
    const requests: string[] = [];
    await page.route('**/api/explore/**', r => {
      requests.push(r.request().url());
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/browse')) return r.fulfill(json(ok({ results: [], total: 0, locationSet: true })));
      if (path.endsWith('/categories')) return r.fulfill(json(ok({ locationSet: true, siteId: 's', siteName: 'Home', categories: [] })));
      return r.fulfill(json(ok({ results: [], locationSet: true })));
    });
    await page.goto('/explore/all?visibility=tonight&sort=tonight&night=2027-01-15');
    await expect(page.getByRole('heading', { name: /^Best on .*Jan/ })).toBeVisible();
    await expect(page.getByText(/Showing .*Jan.*, the night chosen in the Planner\./)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Up on .*Jan/ })).toBeVisible();
    await expect.poll(() => requests.some(u => u.includes('/browse') && u.includes('date=2027-01-15'))).toBe(true);

    await page.getByRole('button', { name: 'Back to tonight' }).first().click();
    await expect(page).not.toHaveURL(/night=/);
    await expect(page.getByRole('heading', { name: 'Best tonight' })).toBeVisible();
  });

  test('a night typed into the address that is not a date is ignored, not sent to the server', async ({ page }) => {
    await mockAllRoutes(page);
    const requests: string[] = [];
    await page.route('**/api/explore/**', r => {
      requests.push(r.request().url());
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/browse')) return r.fulfill(json(ok({ results: [], total: 0, locationSet: true })));
      return r.fulfill(json(ok({ locationSet: true, siteId: 's', siteName: 'Home', categories: [], results: [] })));
    });
    await page.goto('/explore/all?night=banana');
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests.some(u => u.includes('date='))).toBe(false);
  });

  test('Open in Planner on an Explore card goes to the Planner with that object searched for', async ({ page }) => {
    await mockAllRoutes(page);
    const row = {
      id: 'M31', name: 'Andromeda Galaxy', designation: 'M31', aliases: ['NGC224'], type: 'Galaxy', typeCode: 'G', category: 'galaxies', constellation: 'Andromeda',
      magnitude: 3.4, majorAxisArcmin: 190, ra: 0.71, dec: 41.27, thumbUrl: '/x', showpiece: 120, isShowpiece: true,
      visibility: { kind: 'tonight', maxAlt: 80, bestFrom: 'Jul', bestTo: 'Dec', tonightMaxAlt: 80 }, tonightScore: 0.9, fit: null,
      isInWishlist: false, isImaged: false, libraryObjectId: null,
    };
    await page.route('**/api/explore/browse**', r => r.fulfill(json(ok({ results: [row], total: 1, locationSet: true }))));
    await page.route('**/api/explore/categories**', r => r.fulfill(json(ok({ locationSet: true, siteId: 's', siteName: 'Home', categories: [] }))));
    await page.goto('/explore/galaxies?night=2027-01-15');

    // The card says which night "up" means.
    await expect(page.getByRole('button', { name: /^Open M31 - Andromeda Galaxy$/ })).toContainText('Up on');
    await page.getByRole('button', { name: /in the Planner$/ }).click();
    await expect(page).toHaveURL(/\/planner$/);
    await expect(page.getByPlaceholder(/search/i).first()).toHaveValue('M31');
  });
});

test('a wishlist card links to the Planner and to the Explore tile it belongs to', async ({ page }) => {
  await mockAllRoutes(page);
  await mockWishlist(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/wishlist');
  await expect(page.getByText('Orion Nebula')).toBeVisible();
  // Orion Nebula is an emission nebula: its "Find similar" is that tile.
  // The card's small actions appear on hover.
  await page.getByText('Orion Nebula').first().hover();
  // Exact, because the card is itself a button whose name contains its inner buttons' labels.
  await page.getByRole('button', { name: 'Find more like Orion Nebula in Explore', exact: true }).click();
  await expect(page).toHaveURL(/\/explore\/emission-nebulae$/);
});
