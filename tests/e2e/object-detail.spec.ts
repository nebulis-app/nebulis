import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth } from './fixtures/mocks';

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

  test('shows the catalog facts panel', async ({ page }) => {
    await expect(page.getByText('Magnitude')).toBeVisible();
    await expect(page.getByText('4.00')).toBeVisible();
    await expect(page.getByText('05h 35m 17s')).toBeVisible();
  });

  test('renders declination without dropping its arcminutes', async ({ page }) => {
    // Regression: an already-sexagesimal value was re-parsed with parseFloat and
    // reformatted, turning "-05° 23′ 28″" into "-05° 00′ 0.0″".
    await expect(page.getByText('-05° 23′ 28″')).toBeVisible();
  });

  test('totals the object across its observations', async ({ page }) => {
    await expect(page.getByText('Observations', { exact: true })).toBeVisible();
    // Integration comes from the capture sidecar: 5400s on the mocked night.
    await expect(page.getByText('Integration', { exact: true })).toBeVisible();
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
    await expect(page.getByRole('button', { name: /compare/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /download/i })).toBeVisible();
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
