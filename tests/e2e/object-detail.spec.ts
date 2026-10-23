import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, mockRoute, MOCK } from './fixtures/mocks';

/**
 * The object page: what you have shot of one target.
 *
 * The two suites that used to live here covered `/object/:id/session/:date` and
 * a sub-frames page. Neither route exists any more (a night is now
 * `/observations/:objectId/:date`, covered by observations.spec.ts), so they
 * were asserting against a router 404 rather than against anything real.
 */
test.describe('Object Detail', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('shows object name', async ({ page }) => {
    // Exact: the About panel is titled "About Orion Nebula" and is also a heading.
    await expect(page.getByRole('heading', { name: 'Orion Nebula', exact: true })).toBeVisible();
  });

  test('shows catalog id, type and constellation', async ({ page }) => {
    await expect(page.getByText(/M42 · Emission Nebula · Orion/i)).toBeVisible();
  });

  test('shows the headline catalog facts in the hero', async ({ page }) => {
    await expect(page.getByText('Magnitude')).toBeVisible();
    await expect(page.getByText('4.00')).toBeVisible();
  });

  test('shows the full catalog facts once About is opened', async ({ page }) => {
    await page.getByRole('button', { name: /About Orion Nebula/ }).click();
    await expect(page.getByText('05h 35m 17s')).toBeVisible();
  });

  test('renders declination without dropping its arcminutes', async ({ page }) => {
    // Regression: an already-sexagesimal value was re-parsed with parseFloat and
    // reformatted, turning "-05° 23′ 28″" into "-05° 00′ 0.0″".
    await page.getByRole('button', { name: /About Orion Nebula/ }).click();
    await expect(page.getByText('-05° 23′ 28″')).toBeVisible();
  });

  test('totals the object across its observations', async ({ page }) => {
    await expect(page.getByText('Observations', { exact: true })).toBeVisible();
    // Integration comes from the capture sidecar: 5400s on the mocked night.
    await expect(page.getByText('Integration', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1h 30m').first()).toBeVisible();
  });

  test('shows tonight visibility for the active site', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /tonight/i })).toBeVisible();
    await expect(page.getByText(/best months/i)).toBeVisible();
  });

  test('lists observations with their date', async ({ page }) => {
    await expect(page.getByText(/Mar 15/).first()).toBeVisible();
    await expect(page.getByText(/Feb 10/).first()).toBeVisible();
  });

  test('an observation card links to that night', async ({ page }) => {
    await page.getByText(/Mar 15/).first().click();
    await expect(page).toHaveURL(/\/observations\/M42\/2024-03-15/);
  });

  test('primary actions are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /add observation/i })).toBeVisible();
    // Download is a HeroAction button (it mints a signed URL then triggers the
    // download), not an <a>, so it is not a link any more.
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    // Compare is a secondary action now, so it lives in the hero's overflow
    // menu with the rest of them rather than as a top-level button. Assert it
    // is absent before opening the menu so this cannot pass on an empty menu.
    await expect(page.getByRole('menuitem', { name: /^compare$/i })).toHaveCount(0);
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /^compare$/i })).toBeVisible();
  });

  test('destructive actions live behind the overflow menu', async ({ page }) => {
    await expect(page.getByRole('menuitem', { name: /delete object/i })).toHaveCount(0);
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /delete object/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /edit object details/i })).toBeVisible();
  });

  test('the overflow menu reveals the on-disk file location', async ({ page }) => {
    await page.getByRole('button', { name: /more actions/i }).click();
    await page.getByRole('menuitem', { name: /show file location/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('/srv/nebulis/library/M42')).toBeVisible();
  });

  test('breadcrumb navigates back to the library', async ({ page }) => {
    await page.getByRole('link', { name: 'Library', exact: true }).last().click();
    await expect(page).toHaveURL('/');
  });
});

test.describe('Object Detail — Observations grouped by year', () => {
  // Regression coverage for ObservationsSection.tsx: it groups observation
  // cards by year, but only shows a year heading once an object has actually
  // been shot across more than one year — a single-year object (the default
  // mock, both nights in 2024) must stay one flat grid with no heading at
  // all. Nothing in this file previously exercised the multi-year branch.
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/library/objects/M42/sessions', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [
        {
          id: '2024-03-15', date: '2024-03-15', objectId: 'M42',
          fileCount: 12, stackedCount: 1, fitsCount: 10, imageCount: 1,
          thumbnailUrl: '/api/library/objects/M42/thumbnail',
          filesUrl: '/api/library/objects/M42/sessions/2024-03-15/files',
        },
        {
          id: '2023-11-02', date: '2023-11-02', objectId: 'M42',
          fileCount: 8, stackedCount: 1, fitsCount: 6, imageCount: 1,
          thumbnailUrl: '/api/library/objects/M42/thumbnail',
          filesUrl: '/api/library/objects/M42/sessions/2023-11-02/files',
        },
        {
          id: '2023-10-01', date: '2023-10-01', objectId: 'M42',
          fileCount: 8, stackedCount: 1, fitsCount: 6, imageCount: 1,
          thumbnailUrl: '/api/library/objects/M42/thumbnail',
          filesUrl: '/api/library/objects/M42/sessions/2023-10-01/files',
        },
      ] }),
    }));
    await page.goto('/object/M42');
  });

  test('shows one heading per year, newest first, each with its own count', async ({ page }) => {
    // The year heading span (`font-display ... tabular-nums`) is distinct
    // from the plain `tabular-nums` year printed inside each card's own date
    // line — matching on both classes together avoids that collision.
    const headings = page.locator('span.tabular-nums.font-display');
    await expect(headings).toHaveText(['2024', '2023']);
  });

  test('every night still appears, split across its year group', async ({ page }) => {
    await expect(page.getByText(/Mar 15/).first()).toBeVisible();
    await expect(page.getByText(/Nov 2/).first()).toBeVisible();
    await expect(page.getByText(/Oct 1/).first()).toBeVisible();
  });
});

test.describe('Object Detail — Observations NOT grouped when only one year', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('a single-year object shows no year heading at all', async ({ page }) => {
    // Both mocked M42 nights are 2024 — a bare year heading would be pure
    // noise here, so ObservationsSection must not render one.
    await expect(page.locator('span.tabular-nums.font-display')).toHaveCount(0);
    await expect(page.getByText(/Mar 15/).first()).toBeVisible();
    await expect(page.getByText(/Feb 10/).first()).toBeVisible();
  });
});

test.describe('Object Detail — Processed Images .fit toggle', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/library/objects/*/processed-images', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [
        {
          id: 'proc-jpg-1', objectId: 'M42', date: '2024-03-15',
          filename: 'stacked.jpg', originalName: 'stacked.jpg', title: '', notes: '',
          size: 1000, mimeType: 'image/jpeg', uploadedAt: new Date().toISOString(),
          url: '/api/library/file?path=M42/processed/stacked.jpg', path: 'M42/processed/stacked.jpg',
          thumbUrl: null, runId: null, source: 'upload', runDates: null,
        },
        {
          id: 'proc-fits-1', objectId: 'M42', date: '2024-03-15',
          filename: 'stacked-16.fits', originalName: 'stacked-16.fits', title: '', notes: '',
          size: 2000, mimeType: 'application/octet-stream', uploadedAt: new Date().toISOString(),
          url: '/api/library/file?path=M42/processed/stacked-16.fits', path: 'M42/processed/stacked-16.fits',
          thumbUrl: null, runId: null, source: 'upload', runDates: null,
        },
      ] }),
    }));
    await page.goto('/object/M42');
  });

  test('FITS files are hidden by default, and the .fit pill shows their count', async ({ page }) => {
    const pill = page.getByRole('button', { name: 'FIT (1)' });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('stacked-16.fits')).toHaveCount(0);
  });

  test('clicking the pill reveals FITS files, without hiding the renderable ones', async ({ page }) => {
    await page.getByRole('button', { name: 'FIT (1)' }).click();
    await expect(page.getByRole('button', { name: 'FIT (1)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('stacked-16.fits')).toBeVisible();
    await expect(page.getByText('stacked.jpg').or(page.locator('img[alt=""]')).first()).toBeVisible();
  });

  test('resets to hidden on a fresh page load (not persisted)', async ({ page }) => {
    await page.getByRole('button', { name: 'FIT (1)' }).click();
    await expect(page.getByText('stacked-16.fits')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'FIT (1)' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('stacked-16.fits')).toHaveCount(0);
  });
});

test.describe('Object Detail — banner description', () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} about the Orion Nebula and what makes it worth a long look.`).join(' ');

  test('a short description has no More link', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/object/M42');
    // First: a hidden copy of the text sits beside it to measure whether it fits.
    await expect(page.getByText('The Orion Nebula is the nearest region of massive star formation.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
  });

  test('a long description is clamped and More opens the About section', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    // Registered after the shared mocks, so it wins for this one entry.
    await mockRoute(page, '**/api/catalog/M42', { ...MOCK.catalogEntry, description: LONG });
    await page.goto('/object/M42');

    const more = page.getByRole('button', { name: 'More', exact: true });
    await expect(more).toBeVisible();
    // Collapsed by default: the last sentence is cut off and no About body shows.
    await expect(page.getByText('05h 35m 17s')).toHaveCount(0);

    await more.click();
    await expect(page.getByRole('button', { name: /About Orion Nebula/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('05h 35m 17s')).toBeVisible();
  });
});
