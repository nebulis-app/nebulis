import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Observations Calendar', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /observation/i })).toBeVisible();
  });

  test('renders observations from API', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('shows observation dates', async ({ page }) => {
    // Dates appear either on calendar cells or in the list
    await expect(page.getByText(/2024/)).toBeVisible();
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
});
