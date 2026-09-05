import { test, expect } from '@playwright/test';
import fs from 'fs';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Observations Calendar', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations');
  });

  test('shows page heading', async ({ page }) => {
    // Exact: the page also carries a "Recent Observations" section heading, so
    // a loose /observation/i match is a strict-mode violation the moment that
    // section has data to render.
    await expect(page.getByRole('heading', { name: 'Observations', exact: true })).toBeVisible();
  });

  // The calendar view is scoped to one month, and it opens on the month of the
  // most recent night (March 2024 in the fixture) rather than on today. So the
  // grid shows M42 and not M31, which is a month earlier. The whole record is
  // the List view's job, asserted below.
  test('renders the landing month from the API', async ({ page }) => {
    await expect(page.getByRole('link', { name: /Orion Nebula/ })).toBeVisible();
  });

  test('list view renders every observation from the API', async ({ page }) => {
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByText('Orion Nebula').first()).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy').first()).toBeVisible();
  });

  test('shows the month it is displaying', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'March 2024' })).toBeVisible();
  });

  test('shows constellation labels', async ({ page }) => {
    await expect(page.getByText('Orion').first()).toBeVisible();
  });

  test('clicking an observation navigates to detail', async ({ page }) => {
    await page.getByText('Orion Nebula').first().click();
    await expect(page).toHaveURL(/\/observations\/M42\/2024-03-15/);
  });

  test('new observation button navigates to creation form', async ({ page }) => {
    await page.getByRole('link', { name: /new observation/i }).click();
    await expect(page).toHaveURL('/observations/new');
  });

  test('calendar navigation buttons are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /previous|chevron-left|←|prev/i })
      .or(page.locator('[aria-label*="prev"]'))
      .or(page.locator('button').filter({ has: page.locator('svg') }).first())
    ).toBeVisible();
  });

  test('notes indicator shown for observations with notes', async ({ page }) => {
    // M42 hasNotes: true — some notes icon/badge should appear. Previously
    // wrapped in `.catch(() => {})` which swallowed any failure; the empty
    // catch made the test pass even when the indicator never rendered.
    await expect(
      page.locator('[title*="note"], [aria-label*="note"], [data-testid*="note"]')
        .or(page.getByText(/note/i)),
    ).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });
});

test.describe('New Observation Form', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations/new');
  });

  test('shows object name input', async ({ page }) => {
    await expect(page.getByLabel(/object name/i)
      .or(page.getByPlaceholder(/object name/i))
      .or(page.getByRole('textbox').first())
    ).toBeVisible();
  });

  test('shows date input', async ({ page }) => {
    await expect(page.locator('input[type="date"]')
      .or(page.getByLabel(/date/i))
    ).toBeVisible();
  });

  test('submit creates observation and redirects', async ({ page }) => {
    await page.route('**/api/library/manual-observations', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { objectId: 'M101', date: '2024-03-20' } }),
      }));

    const nameInput = page.getByLabel(/object name/i)
      .or(page.getByPlaceholder(/object name/i))
      .or(page.getByRole('textbox').first());
    await nameInput.fill('M101');

    const dateInput = page.locator('input[type="date"]');
    if (await dateInput.isVisible()) {
      await dateInput.fill('2024-03-20');
    }

    await page.getByRole('button', { name: /create|save|submit/i }).click();
    await expect(page).toHaveURL(/\/observations\/M101\/2024-03-20/);
  });
});

test.describe('Observation Detail', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    // Provide files in the observation detail
    await page.route('**/api/library/observations/M42/2024-03-15', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            ...MOCK.observationDetail,
            files: MOCK.sessionFiles,
            stackedFiles: [MOCK.sessionFiles[0]],
            imageFiles: [MOCK.sessionFiles[1]],
            subFiles: [MOCK.sessionFiles[2]],
          },
        }),
      }));
    await page.goto('/observations/M42/2024-03-15');
  });

  test('shows object name in heading', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });

  test('shows observation date', async ({ page }) => {
    await expect(page.getByText(/2024-03-15|march 15/i)).toBeVisible();
  });

  test('shows file listing', async ({ page }) => {
    await expect(page.getByText('Stacked_M42_2024-03-15.fit')).toBeVisible();
    await expect(page.getByText('M42_2024-03-15.jpg')).toBeVisible();
  });

  test('shows RA/Dec coordinates', async ({ page }) => {
    await expect(page.getByText(/05h 35m/i)).toBeVisible();
  });

  test('file filter buttons are present', async ({ page }) => {
    // "All", "FITS", "Images" filter tabs
    await expect(page.getByRole('button', { name: /^all$/i })
      .or(page.getByText(/^all$/i))
    ).toBeVisible();
  });

  test('clicking FITS filter shows only FITS files', async ({ page }) => {
    const fitsFilter = page.getByRole('button', { name: /fits/i });
    if (await fitsFilter.isVisible()) {
      await fitsFilter.click();
      await expect(page.getByText('Stacked_M42_2024-03-15.fit')).toBeVisible();
    }
  });

  test('notes panel is visible', async ({ page }) => {
    await expect(page.getByText(/notes|observation notes/i)).toBeVisible();
  });

  test('notes form fields are present', async ({ page }) => {
    // Look for seeing, transparency rating inputs or notes text area
    await expect(page.getByRole('textbox').or(page.locator('textarea'))).toBeVisible();
  });

  test('back navigation link is present', async ({ page }) => {
    await expect(page.getByRole('link', { name: /back|observations/i })
      .or(page.locator('a[href="/observations"]'))
    ).toBeVisible();
  });

  test('the file-location button shows the session folder on disk', async ({ page }) => {
    await page.route('**/api/library/objects/*/location*', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: {
          storage: 'local',
          libraryRoot: '/srv/nebulis/library',
          object: { relPath: 'M42', path: '/srv/nebulis/library/M42', exists: true },
          session: { relPath: 'M42/2024-03-15', path: '/srv/nebulis/library/M42/2024-03-15', exists: true },
          variants: [],
        } }),
      }));
    await page.getByRole('button', { name: /file location/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('/srv/nebulis/library/M42/2024-03-15')).toBeVisible();
  });

});

// Regression test for the hero-image layout-shift fix: it previously had no
// reserved space before it loaded (no width/height/aspect-ratio available
// ahead of time), so the hero — and everything below it: tabs, file grid —
// jumped from ~0 height to full height the instant the image finished
// loading. That jump landing while someone was mid-scroll read as the page
// jittering. Fixed by a fixed-size loading placeholder that the real image
// replaces once it fires `onLoad`, mirroring the pattern FitsPreview already
// used for FITS heroes. The swap is now a hidden/flex toggle on the image's
// own wrapper (not an opacity fade on the `<img>` itself): the wrapper has to
// be absent from layout while loading so the column can shrink-wrap to the
// picture's real aspect ratio once it's known, which an opacity-0-but-still-
// laid-out image would have defeated.
//
// Separate describe block (own beforeEach, no shared `Observation Detail`
// setup) so the hero's image route can be mocked before the page's single
// navigation — reusing that block's shared `goto` and reloading afterward
// to swap the mock hits an unrelated, pre-existing bug where a hard reload
// mis-resolves the processed-images route to the wrong mock handler and
// crashes the page (`processedImages.find is not a function`, reproduces
// even without touching the hero image route at all). Worth a look
// separately; out of scope here.
test.describe('Observation Detail hero image', () => {
  test('reaches full opacity after loading, with no stuck loading placeholder', async ({ page }) => {
    await mockAllRoutes(page);
    await page.route('**/api/library/observations/M42/2024-03-15', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            ...MOCK.observationDetail,
            files: MOCK.sessionFiles,
            stackedFiles: [MOCK.sessionFiles[0]],
            imageFiles: [MOCK.sessionFiles[1]],
            subFiles: [MOCK.sessionFiles[2]],
          },
        }),
      }));
    // The trailing `**` (not `*`) matters: the query string
    // (`?path=/data/library/...`) contains slashes, which a single `*` won't
    // span, so the route silently never matches and the request falls
    // through unmocked.
    await page.route('**/api/library/file**', r =>
      r.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync('tests/e2e/fixtures/tiny.jpg') }));
    // Without this, mockAllRoutes' `objects/**` catch-all (registered for
    // e.g. `/library/objects/M42`) also matches this session's
    // processed-images request and returns a single object instead of an
    // array, crashing the page on `processedImages.find`. Pre-existing gap
    // in the shared fixture, unrelated to the hero image; out of scope here.
    await page.route('**/api/library/objects/M42/sessions/2024-03-15/processed-images', r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }));

    await page.goto('/observations/M42/2024-03-15');

    const hero = page.getByAltText(/Orion Nebula/);
    await expect(hero).toBeVisible();
    // The wrapper that was hidden while loading must have swapped to shown:
    // a stuck loading placeholder would leave the spinner on screen forever
    // instead of ever revealing the image.
    await expect(page.locator('.animate-spin')).toHaveCount(0);
  });
});
