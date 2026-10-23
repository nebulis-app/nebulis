/**
 * Explore: global search, browse tiles and a category page. The server's
 * ranking and visibility are covered in tests/backend/explore.test.ts; this
 * checks that what the server says reaches the screen, and that the actions on
 * it (add to wishlist, open a category) do what they say.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, json, ok } from './fixtures/mocks';

function row(over: Record<string, unknown>) {
  return {
    id: 'M42', name: 'Great Orion Nebula', designation: 'M42', aliases: ['NGC1976'],
    type: 'Cluster + Nebula', typeCode: 'Cl+N', category: 'emission-nebulae', constellation: 'Orion',
    magnitude: 4, majorAxisArcmin: 85, ra: 5.59, dec: -5.39,
    thumbUrl: '/api/catalog/M42/image?w=384&h=384', showpiece: 120, isShowpiece: true,
    visibility: { kind: 'tonight', maxAlt: 49, bestFrom: 'Oct', bestTo: 'Mar', tonightMaxAlt: 49 },
    tonightScore: 0.8, isInWishlist: false, isImaged: false, libraryObjectId: null,
    ...over,
  };
}

const ORION = row({});
const ANDROMEDA = row({
  fit: { tag: 'mosaic', fillRatio: 4.2, mosaicCols: 3, mosaicRows: 2 },
  id: 'M31', name: 'Andromeda Galaxy', designation: 'M31', aliases: ['NGC224'], type: 'Galaxy', typeCode: 'G',
  category: 'galaxies', constellation: 'Andromeda', magnitude: 3.4,
  visibility: { kind: 'season', maxAlt: 80, bestFrom: 'Jul', bestTo: 'Dec', tonightMaxAlt: null },
});
const SOUTHERN = row({
  fit: { tag: 'fits', fillRatio: 0.4 },
  id: 'NGC253', name: 'Sculptor Galaxy', designation: 'NGC253', aliases: ['C65'], type: 'Galaxy', typeCode: 'G',
  category: 'galaxies', constellation: 'Sculptor',
  visibility: { kind: 'low', maxAlt: 28, bestFrom: 'Nov', bestTo: 'Nov', tonightMaxAlt: null },
});

async function mockExplore(page: Page) {
  await mockAllRoutes(page);
  const posts: Array<Record<string, unknown>> = [];
  await page.route('**/api/wishlist', async r => {
    if (r.request().method() === 'POST') {
      posts.push(r.request().postDataJSON() as Record<string, unknown>);
      await r.fulfill(json(ok({ id: 'w1', ...posts[posts.length - 1] })));
    } else {
      await r.fulfill(json(ok([])));
    }
  });
  await page.route('**/api/explore/categories**', r => r.fulfill(json(ok({
    locationSet: true, siteId: 'site-1', siteName: 'Home',
    categories: [
      { id: 'showpieces', total: 67, visibleHere: 62, goodTonight: 50 },
      { id: 'galaxies', total: 3062, visibleHere: 2449, goodTonight: 1512 },
      { id: 'emission-nebulae', total: 486, visibleHere: 409, goodTonight: 379 },
      { id: 'planetary-nebulae', total: 111, visibleHere: 78, goodTonight: 72 },
      { id: 'supernova-remnants', total: 12, visibleHere: 9, goodTonight: 9 },
      { id: 'clusters', total: 707, visibleHere: 420, goodTonight: 363 },
      { id: 'dark-reflection', total: 37, visibleHere: 30, goodTonight: 29 },
      { id: 'galaxy-groups', total: 243, visibleHere: 222, goodTonight: 133 },
    ],
  }))));
  await page.route('**/api/explore/best-tonight**', r => r.fulfill(json(ok({ results: [ORION], locationSet: true }))));
  await page.route('**/api/explore/search**', r => {
    const q = new URL(r.request().url()).searchParams.get('q') ?? '';
    const results = /m42|orion/i.test(q) ? [ORION] : [];
    return r.fulfill(json(ok({ results, total: results.length, constellation: null, locationSet: true })));
  });
  await page.route('**/api/explore/browse**', r => {
    browseUrls.push(r.request().url());
    return r.fulfill(json(ok({ results: [ANDROMEDA, SOUTHERN], total: 2, locationSet: true })));
  });
  return posts;
}
const browseUrls: string[] = [];

test.describe('Explore', () => {
  test('landing shows tonight\'s best and a tile per kind with how many you can see', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore');

    await expect(page.getByRole('heading', { name: 'Explore', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Best tonight from your site' })).toBeVisible();
    // The rail card carries the object's name and the "Up tonight" chip.
    await expect(page.getByRole('button', { name: /Open M42/ })).toBeVisible();

    const galaxies = page.getByRole('link', { name: 'Galaxies' });
    await expect(galaxies).toContainText('3,062 objects');
    await expect(galaxies).toContainText('2,449 visible here');
    await expect(galaxies).toContainText('1,512 up tonight');
    await expect(page.getByRole('link', { name: 'Showpieces' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Supernova remnants' })).toBeVisible();
  });

  test('typing a designation lists it with its visibility and adds it to the wishlist', async ({ page }) => {
    const posts = await mockExplore(page);
    await page.goto('/explore');

    await page.getByRole('combobox', { name: 'Search the sky' }).fill('M42');
    const option = page.getByRole('option').filter({ hasText: 'Great Orion Nebula' });
    await expect(option).toBeVisible();
    await expect(option).toContainText('NGC1976');
    await expect(option).toContainText('Up tonight');

    await option.getByRole('button', { name: /Add .* to wishlist/ }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ objectId: 'M42', name: 'Great Orion Nebula', constellation: 'Orion' });
  });

  test('a search with no match says so instead of showing an empty box', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore');
    await page.getByRole('combobox', { name: 'Search the sky' }).fill('zzzz');
    await expect(page.getByText('Nothing found for "zzzz"')).toBeVisible();
  });

  test('a category page shows each object\'s season and how reachable it is', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore');
    await page.getByRole('link', { name: 'Galaxies' }).click();

    await expect(page).toHaveURL(/\/explore\/galaxies$/);
    await expect(page.getByRole('heading', { name: 'Galaxies', level: 1 })).toBeVisible();
    const m31 = page.getByRole('button', { name: /Open M31/ });
    await expect(m31).toContainText('Best Jul to Dec');
    await expect(page.getByRole('button', { name: /Open NGC253/ })).toContainText('Low from here');
    // Not up tonight, so planning it for tonight is not offered.
    await expect(page.getByRole('button', { name: 'Plan tonight' }).first()).toBeDisabled();
  });

  test('the visibility filter lives in the URL so a link reproduces the view', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore/galaxies');
    await page.getByRole('button', { name: 'Up tonight' }).click();
    await expect(page).toHaveURL(/visibility=tonight/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Up tonight' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('browse tiles use pictures bundled with the app, so they need no catalog image requests', async ({ page }) => {
    const imageRequests: string[] = [];
    page.on('request', req => { if (/\/api\/catalog\/[^/]+\/image/.test(req.url())) imageRequests.push(req.url()); });
    await mockExplore(page);
    await page.goto('/explore');
    const tile = page.getByRole('link', { name: 'Galaxies' }).locator('img');
    await expect(tile).toBeVisible();
    // A fingerprinted build asset, not a route that needs the server's cache.
    expect(await tile.getAttribute('src')).not.toContain('/api/');
    await expect.poll(() => tile.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    // Only the best-tonight card may ask for a catalog picture; no tile does.
    expect(imageRequests.every(u => /\/M42\//.test(u))).toBe(true);
  });

  test('Fits my scope sends the field of view, and cards show how each object fits it', async ({ page }) => {
    browseUrls.length = 0;
    await mockExplore(page);
    await page.goto('/explore/galaxies');
    // The verdict badge on each card: a mosaic target and a comfortable fit.
    await expect(page.getByRole('button', { name: /Open M31/ }).locator('xpath=ancestor::div[contains(@class,"group")][1]')).toContainText(/mosaic/i);
    await expect(page.getByRole('button', { name: /Open NGC253/ }).locator('xpath=ancestor::div[contains(@class,"group")][1]')).toContainText(/fits/i);

    // State lives in the URL, so it flips a render after the click.
    await page.getByRole('checkbox', { name: 'Fits my scope' }).click();
    await expect(page.getByRole('checkbox', { name: 'Fits my scope' })).toBeChecked();
    await expect(page).toHaveURL(/fitsScope=1/);
    await expect.poll(() => browseUrls.some(u => /fitsScope=1/.test(u) && /fovW=[\d.]+/.test(u) && /fovH=[\d.]+/.test(u))).toBe(true);
    // Without the filter the same request still carries the field of view, for the badges.
    expect(browseUrls.some(u => !/fitsScope/.test(u) && /fovW=/.test(u))).toBe(true);
  });
});
