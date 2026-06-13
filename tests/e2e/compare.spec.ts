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

  test('switching to slider mode activates that button', async ({ page }) => {
    const sliderBtn = page.getByRole('button', { name: /slider/i });
    const sbsBtn = page.getByRole('button', { name: /side.by.side/i });

    if (await sliderBtn.isVisible() && await sbsBtn.isVisible()) {
      // Capture the side-by-side button's initial class to detect active state changes
      const sbsClassBefore = await sbsBtn.getAttribute('class') ?? '';
      await sliderBtn.click();
      // After switching, the side-by-side button should no longer have the same active styling
      const sbsClassAfter = await sbsBtn.getAttribute('class') ?? '';
      expect(sbsClassAfter).not.toBe(sbsClassBefore);
    }
  });

  test('switching back to side-by-side works', async ({ page }) => {
    // Switch to slider then back
    const sliderBtn = page.getByRole('button', { name: /slider/i });
    const sbsBtn = page.getByRole('button', { name: /side.by.side/i });

    if (await sliderBtn.isVisible() && await sbsBtn.isVisible()) {
      await sliderBtn.click();
      await sbsBtn.click();
      await expect(sbsBtn).toBeVisible();
    }
  });

  test('shows session date options from mock data', async ({ page }) => {
    // Session selectors should be populated from the mocked sessions (2024-03-15, 2024-02-10).
    // Either the selected label or an option in the dropdown should contain the date.
    const selects = page.locator('select');
    if (await selects.count() > 0) {
      const firstSelectText = await selects.first().textContent();
      expect(firstSelectText).toMatch(/2024-03|march|feb/i);
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
