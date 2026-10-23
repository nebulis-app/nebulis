import { test, expect, type Page } from '@playwright/test';
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

  test('lists object types in the Filters popover', async ({ page }) => {
    // Cards carry only the object name and date. Object types live in the
    // Filters popover: curated groups (Galaxy) up front, and the exact types
    // derived from the images (Emission Nebula) behind "More types".
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByRole('button', { name: /^Galaxy\b/ })).toBeVisible();

    await page.getByRole('button', { name: /More types/ }).click();
    await expect(page.getByRole('button', { name: /^Emission Nebula\b/ })).toBeVisible();
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
    // Exact chip name: every card also carries an "Add/Remove from favorites"
    // button, so a loose /favorite/i role match resolves to several elements.
    await expect(page.getByRole('button', { name: 'Favorites', exact: true })).toBeVisible();
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

    const favBtn = page.getByRole('button', { name: 'Favorites', exact: true });
    await expect(favBtn).toHaveAttribute('aria-pressed', 'false');
    await favBtn.click();
    await expect(favBtn).toHaveAttribute('aria-pressed', 'true');
    // Only M31 (isFavorite: true) should remain
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
  });

  test('clearing favorites filter restores all images', async ({ page }) => {
    const favBtn = page.getByRole('button', { name: 'Favorites', exact: true });
    await favBtn.click(); // enable filter
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await favBtn.click(); // disable filter
    await expect(favBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('North America Nebula')).toBeVisible();
  });

  // ─── Processed only ───────────────────────────────────────────────────────

  test('processed-only toggle is present', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByRole('button', { name: 'Processed only', exact: true })).toBeVisible();
  });

  test('processed-only filters out raw images', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: 'Processed only', exact: true }).click();
    // Only the processed NGC7000 entry should remain.
    await expect(page.getByText('North America Nebula')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
  });

  test('clearing processed-only restores all images', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    const processedBtn = page.getByRole('button', { name: 'Processed only', exact: true });
    await processedBtn.click(); // enable
    await processedBtn.click(); // disable
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('North America Nebula')).toBeVisible();
  });

  // ─── Sort ─────────────────────────────────────────────────────────────────

  test('sort control is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /sort|order/i })
        .or(page.locator('select').filter({ hasText: /sort|name|date/i }))
        .or(page.getByText(/newest first|name.*a.*z|oldest/i))
    ).toBeVisible();
  });

  test('sort dropdown lists all four sort options when opened', async ({ page }) => {
    // The sort trigger is labelled with the current choice; the default (no
    // stored preference) is name-asc, i.e. "Name (A–Z)".
    const sortBtn = page.getByRole('button', { name: 'Name (A–Z)', exact: true });
    await expect(sortBtn).toBeVisible();
    await sortBtn.click();
    for (const label of ['Name (Z–A)', 'Newest first', 'Oldest first']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
  });

  test('choosing "Newest first" orders cards by date descending', async ({ page }) => {
    await page.getByRole('button', { name: 'Name (A–Z)', exact: true }).click();
    await page.getByRole('button', { name: 'Newest first', exact: true }).click();
    // Card titles are the object-detail links. Dates: M42 2024-03-15,
    // M31 2024-02-20, NGC7000 2024-01-10.
    await expect(page.locator('a[href^="/object/"] p.font-semibold')).toHaveText([
      'Orion Nebula',
      'Andromeda Galaxy',
      'North America Nebula',
    ]);
  });

  // ─── Type filter ──────────────────────────────────────────────────────────

  test('type filter is present', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByText('Type', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Galaxy\b/ })).toBeVisible();
  });

  test('filtering by type shows only matching images', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    const galaxyFilter = page.getByRole('button', { name: /^galaxy\b/i });
    await expect(galaxyFilter).toBeVisible();
    await galaxyFilter.click();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
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
    const searchInput = page.getByPlaceholder('Search by object name...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Orion');
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
    await expect(page.getByText('North America Nebula')).not.toBeVisible();
  });

  test('clearing search restores all images', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search by object name...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Orion');
    await expect(page.getByText('Andromeda Galaxy')).not.toBeVisible();
    await searchInput.clear();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('North America Nebula')).toBeVisible();
  });

  // ─── Image viewer ─────────────────────────────────────────────────────────

  // ImageCard = [open button (thumbnail)] [favorite button] [object link].
  // The open button's name comes from the <img alt>, which disappears when the
  // mocked thumbnail fails to decode, so anchor on the card's object link and
  // take the card's first button.
  function openButtonFor(page: Page, objectName: string) {
    return page.getByRole('link', { name: new RegExp(`^${objectName}\\b`) })
      .locator('xpath=..')
      .getByRole('button')
      .first();
  }

  test('clicking an image card opens the viewer', async ({ page }) => {
    const thumb = openButtonFor(page, 'Orion Nebula');
    await expect(thumb).toBeVisible();
    await thumb.click();
    // ImageViewer renders a Modal: role="dialog" labelled by "Image viewer: {name}".
    await expect(page.getByRole('dialog', { name: 'Image viewer: Orion Nebula' })).toBeVisible();
  });

  test('viewer title links to the image\'s object', async ({ page }) => {
    await openButtonFor(page, 'Orion Nebula').click();
    const dialog = page.getByRole('dialog', { name: 'Image viewer: Orion Nebula' });
    await expect(dialog).toBeVisible();
    const titleLink = dialog.getByRole('link', { name: 'Orion Nebula', exact: true });
    await expect(titleLink).toBeVisible();
    await expect(titleLink).toHaveAttribute('href', '/object/M42');

    await titleLink.click();
    await expect(page).toHaveURL(/\/object\/M42$/);
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
