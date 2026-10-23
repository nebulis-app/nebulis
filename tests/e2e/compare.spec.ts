import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth } from './fixtures/mocks';

test.describe('Compare Sessions', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/object/M42/compare');
  });

  test('shows Compare Sessions heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /compare sessions/i })).toBeVisible();
  });

  test('shows back navigation to object', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /back|M42|orion/i })
        .or(page.locator(`a[href*="/object/M42"]`))
        .first()
    ).toBeVisible();
  });

  test('back link navigates to object detail', async ({ page }) => {
    await page.getByRole('link', { name: /back|M42|orion/i })
      .or(page.locator(`a[href*="/object/M42"]`))
      .first()
      .click();
    await expect(page).toHaveURL('/object/M42');
  });

  test('side-by-side mode button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /side.by.side|side by side/i })
        .or(page.getByText(/side.by.side/i))
    ).toBeVisible();
  });

  test('slider mode button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /slider/i })
        .or(page.getByText(/slider/i))
    ).toBeVisible();
  });

  test('session selector dropdowns are present', async ({ page }) => {
    const selects = page.locator('select');
    await expect(selects.first()).toBeVisible();
  });

  // Observable mode contract (CompareView): slider mode overlays the two
  // sessions and adds a range input (role slider, 5-95, starting at 50) that
  // drives the split; side-by-side mode has no slider.
  test('should show the comparison slider when Slider mode is selected', async ({ page }) => {
    const sliderBtn = page.getByRole('button', { name: 'Slider', exact: true });
    await expect(sliderBtn).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);

    await sliderBtn.click();
    const range = page.getByRole('slider');
    await expect(range).toHaveCount(1);
    await expect(range).toHaveValue('50');
  });

  test('should remove the slider when switching back to Side by Side', async ({ page }) => {
    await page.getByRole('button', { name: 'Slider', exact: true }).click();
    await expect(page.getByRole('slider')).toHaveCount(1);

    await page.getByRole('button', { name: 'Side by Side', exact: true }).click();
    await expect(page.getByRole('slider')).toHaveCount(0);
  });

  test('should list each mocked session as an option in the session selectors', async ({ page }) => {
    // MOCK.sessions: 2024-03-15 (1 stacked, 12 files), 2024-02-10 (1 stacked, 8 files)
    const selects = page.locator('select');
    await expect(selects).toHaveCount(2);
    for (const i of [0, 1]) {
      await expect(selects.nth(i).locator('option')).toHaveText([
        'Select session...',
        'Mar 15, 2024 (1 stacked, 12 files)',
        'Feb 10, 2024 (1 stacked, 8 files)',
      ]);
    }
  });
});

// ─── Empty state (no sessions) ────────────────────────────────────────────────

test.describe('Compare Sessions — no sessions', () => {
  test('renders without crashing when object has no sessions', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/library/objects/M42/sessions', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      }));

    await page.goto('/object/M42/compare');

    await expect(page.getByRole('heading', { name: /compare sessions/i })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/unexpected application error/i);
  });
});
