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
    catalogs: [
      { id: 'messier', total: 110, visibleHere: 105, goodTonight: 60 },
      { id: 'ngc', total: 3718, visibleHere: 3000, goodTonight: 1400 },
      { id: 'ic', total: 725, visibleHere: 512, goodTonight: 414 },
      { id: 'caldwell', total: 109, visibleHere: 100, goodTonight: 50 },
      { id: 'sharpless', total: 313, visibleHere: 250, goodTonight: 120 },
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
    await expect(page.getByRole('heading', { name: 'Galaxies', level: 2 })).toBeVisible();
    const m31 = page.getByRole('button', { name: /Open M31/ });
    await expect(m31).toContainText('Best Jul to Dec');
    await expect(page.getByRole('button', { name: /Open NGC253/ })).toContainText('Low from here');
    // Not up tonight, so planning it for tonight is not offered.
    await expect(page.getByRole('button', { name: 'Plan tonight' }).first()).toBeDisabled();
  });

  test('a category keeps the search and tabs, and its chips move sideways keeping the filters', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore/galaxies?visibility=tonight');

    await expect(page.getByRole('combobox', { name: 'Search the sky' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
    const chips = page.getByRole('group', { name: 'Categories' });
    await expect(chips.getByRole('link', { name: 'Galaxies' })).toHaveAttribute('aria-current', 'page');

    await chips.getByRole('link', { name: 'Star clusters' }).click();
    await expect(page).toHaveURL(/\/explore\/clusters\?visibility=tonight$/);
    await expect(page.getByRole('heading', { name: 'Star clusters', level: 2 })).toBeVisible();

    // The breadcrumb's first step goes back to the Discover landing.
    await page.getByRole('navigation', { name: 'Where you are' }).getByRole('link', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/explore$/);
  });

  test('search results keep the query in the box', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore/all?q=andromeda');
    await expect(page.getByRole('combobox', { name: 'Search the sky' })).toHaveValue('andromeda');
  });

  test('the visibility filter lives in the URL so a link reproduces the view', async ({ page }) => {
    await mockExplore(page);
    await page.goto('/explore/galaxies');
    await page.getByRole('button', { name: 'Up tonight' }).click();
    await expect(page).toHaveURL(/visibility=tonight/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Up tonight' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the hub links to a catalog, and the results page filters by it and keeps it in the URL', async ({ page }) => {
    await mockExplore(page);
    const asked: string[] = [];
    page.on('request', req => { if (req.url().includes('/api/explore/browse')) asked.push(req.url()); });

    await page.goto('/explore');
    await expect(page.getByRole('heading', { name: 'Browse by catalog' })).toBeVisible();
    // The tile carries the same counts a kind tile does.
    const tile = page.getByRole('link', { name: 'IC', exact: true });
    await expect(tile).toContainText('725 objects');
    await expect(tile).toContainText('512 visible here');
    await tile.click();
    await expect(page).toHaveURL(/\/explore\/all\?catalog=ic/);
    await expect(page.getByRole('heading', { name: 'IC objects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'IC', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => asked.some(u => new URL(u).searchParams.get('catalog') === 'ic')).toBe(true);

    // Number orders by the catalog's own numbering, so it is offered only while a catalog is chosen.
    await page.getByRole('button', { name: 'Number', exact: true }).click();
    await expect(page).toHaveURL(/sort=number/);
    await expect.poll(() => asked.some(u => new URL(u).searchParams.get('sort') === 'number')).toBe(true);

    // Another catalog replaces it; All catalogs removes it. A reload keeps the view.
    await page.getByRole('button', { name: 'Caldwell', exact: true }).click();
    await expect(page).toHaveURL(/catalog=caldwell/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Caldwell', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'All catalogs' }).click();
    await expect(page).not.toHaveURL(/catalog=/);
    await expect(page.getByRole('button', { name: 'Number', exact: true })).toHaveCount(0);
  });

  test('the page behind an object popup does not scroll, over the popup or over the backdrop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await mockExplore(page);
    await page.goto('/explore');
    await page.getByRole('button', { name: /Great Orion Nebula/ }).first().click();
    const popup = page.getByText('Filter recommendations').or(page.getByRole('button', { name: 'Open in Planner' })).first();
    await expect(popup).toBeVisible();

    // The page is taller than the window, so it could scroll if nothing stopped it.
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    // A wheel over the dark area beside the popup, which is where the report said the page moved.
    await page.mouse.move(40, 300);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open in Planner' })).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await page.mouse.wheel(0, 900);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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
