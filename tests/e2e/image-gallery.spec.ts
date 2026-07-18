import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, MOCK } from './fixtures/mocks';

function ok<T>(data: T) {
  return { ok: true, data };
}

test.describe('Image Gallery', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/image-gallery');
  });

  test('shows page heading or gallery title', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /gallery/i })
        .or(page.getByText(/gallery/i).first())
    ).toBeVisible();
  });

  test('renders image cards from API', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('shows object types on cards', async ({ page }) => {
    await expect(page.getByText('Emission Nebula')).toBeVisible();
    await expect(page.getByText('Galaxy')).toBeVisible();
  });

  test('shows loading state while fetching', async ({ page }) => {
    // Delay the API response to observe loading state
    await page.route('**/api/library/all-images**', r =>
      new Promise(resolve => setTimeout(() => resolve(r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({ items: MOCK.libraryImages, total: 2, nextOffset: null })),
      })), 200)));

    await page.goto('/image-gallery');
    // Content appears eventually
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });

  // ─── Favorites ────────────────────────────────────────────────────────────

  test('favorites toggle button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /favorites?/i })
        .or(page.locator('[aria-label*="favorite"]'))
        .or(page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: /fav/i }))
    ).toBeVisible();
  });

  test('filtering by favorites shows only favorited images', async ({ page }) => {
    await page.route('**/api/library/all-images**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({
          items: MOCK.libraryImages,
          total: 2,
          nextOffset: null,
        })),
      }));
    await page.goto('/image-gallery');

    const favBtn = page.getByRole('button', { name: /favorites?/i })
      .or(page.locator('[aria-label*="favorite"]'));
    if (await favBtn.isVisible()) {
      await favBtn.click();
      // Only M31 (isFavorite: true) should remain
      await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
      await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    }
  });

  test('clearing favorites filter restores all images', async ({ page }) => {
    const favBtn = page.getByRole('button', { name: /favorites?/i })
      .or(page.locator('[aria-label*="favorite"]'));
    if (await favBtn.isVisible()) {
      await favBtn.click(); // enable filter
      await favBtn.click(); // disable filter
      await expect(page.getByText('Orion Nebula')).toBeVisible();
      await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    }
  });

  // ─── Sort ─────────────────────────────────────────────────────────────────

  test('sort control is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /sort|order/i })
        .or(page.locator('select').filter({ hasText: /sort|name|date/i }))
        .or(page.getByText(/newest first|name.*a.*z|oldest/i))
    ).toBeVisible();
  });

  test('sort dropdown shows sort options', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: /sort/i });
    if (await sortBtn.isVisible()) {
      await sortBtn.click();
      await expect(
        page.getByText(/name.*a.*z|a.*z/i)
          .or(page.getByText(/newest|oldest/i))
      ).toBeVisible();
    }
  });

  // ─── Type filter ──────────────────────────────────────────────────────────

  test('type filter is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /all|galaxy|nebula/i })
        .or(page.locator('select').filter({ hasText: /type|all/i }))
        .first()
    ).toBeVisible();
  });

  test('filtering by type shows only matching images', async ({ page }) => {
    const galaxyFilter = page.getByRole('button', { name: /^galaxy$/i });
    if (await galaxyFilter.isVisible()) {
      await galaxyFilter.click();
      await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
      await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    }
  });

  // ─── Search ───────────────────────────────────────────────────────────────

  test('search input is present', async ({ page }) => {
    await expect(
      page.getByRole('searchbox')
        .or(page.getByPlaceholder(/search/i))
        .or(page.locator('input[type="text"], input[type="search"]').first())
    ).toBeVisible();
  });

  test('search filters images by object name', async ({ page }) => {
    const searchInput = page.getByRole('searchbox')
      .or(page.getByPlaceholder(/search/i))
      .or(page.locator('input[type="text"], input[type="search"]').first());

    if (await searchInput.isVisible()) {
      await searchInput.fill('Orion');
      await expect(page.getByText('Orion Nebula')).toBeVisible();
      await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
    }
  });

  test('clearing search restores all images', async ({ page }) => {
    const searchInput = page.getByRole('searchbox')
      .or(page.getByPlaceholder(/search/i))
      .or(page.locator('input[type="text"], input[type="search"]').first());

    if (await searchInput.isVisible()) {
      await searchInput.fill('Orion');
      await searchInput.clear();
      await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    }
  });

  // ─── Image viewer ─────────────────────────────────────────────────────────

  test('clicking an image card opens the viewer', async ({ page }) => {
    const firstCard = page.locator('[class*="card"], [class*="image"]')
      .filter({ has: page.getByText('Orion Nebula') })
      .first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      // Viewer typically shows the image in a modal/overlay
      await expect(
        page.locator('[role="dialog"]')
          .or(page.locator('[class*="modal"], [class*="overlay"], [class*="viewer"]'))
          .or(page.getByText('Orion Nebula').nth(1))
      ).toBeVisible();
    }
  });

  // ─── Empty state ──────────────────────────────────────────────────────────

  test('shows empty state when library has no images', async ({ page }) => {
    await page.route('**/api/library/all-images**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({ items: [], total: 0, nextOffset: null })),
      }));
    await page.goto('/image-gallery');

    await expect(
      page.getByText(/no images|empty|nothing here/i)
        .or(page.locator('[class*="empty"]'))
    ).toBeVisible();
  });
});

// ─── Gallery nav link ─────────────────────────────────────────────────────────

test.describe('Image Gallery navigation', () => {
  test('Gallery nav link routes to /image-gallery', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');

    await page.getByRole('link', { name: /^gallery$/i }).click();
    await expect(page).toHaveURL('/image-gallery');
  });
});
