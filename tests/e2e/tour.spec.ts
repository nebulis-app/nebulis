import { test, expect } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

/**
 * Guided product-tour smoke test.
 *
 * Renders on top of the fully mocked app: verify the welcome card, advancing
 * through the route-backed steps, the spotlight + tooltip, and skip.
 */
test.describe('Guided tour', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('nebulis-tour-seen-v1'));
    await mockAllRoutes(page);
  });

  test('starts from the Help page and walks into the Library step', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('button', { name: 'Start the guided tour' })).toBeVisible();

    await page.getByRole('button', { name: 'Start the guided tour' }).click();

    // Welcome card (centered, no anchor).
    await expect(page.getByText('Meet Nebulis')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start the tour' })).toBeVisible();

    await page.getByRole('button', { name: 'Start the tour' }).click();

    // Should navigate to / (Library) and show the library step.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Your library, front and center')).toBeVisible();
    // The spotlight highlight ring + tooltip are present.
    await expect(page.locator('.nbl-tour-card')).toBeVisible();
  });

  test('advances through route-backed steps to Settings and closes with skip', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('button', { name: 'Start the guided tour' }).click();
    await page.getByRole('button', { name: 'Start the tour' }).click();

    // Library step → next → telescopes step (navigates to /settings).
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText('Point it at your telescope')).toBeVisible();

    // Skip tour closes the overlay and remembers completion.
    await page.getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
    const seen = await page.evaluate(() => localStorage.getItem('nebulis-tour-seen-v1'));
    expect(seen).toBe('1');
  });

  test('welcome card can be dismissed with Not now', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('button', { name: 'Start the guided tour' }).click();
    await expect(page.getByText('Meet Nebulis')).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  test('spotlight appears on a lazy-loaded object page without manual scroll', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('button', { name: 'Start the guided tour' }).click();
    await page.getByRole('button', { name: 'Start the tour' }).click();

    // Library → telescopes (/settings) → sync (no route) → planner (/planner).
    await page.getByRole('button', { name: 'Next' }).click(); // telescopes
    await page.getByRole('button', { name: 'Next' }).click(); // sync
    await page.getByRole('button', { name: 'Next' }).click(); // planner

    // Planner → processed: opens a real object page (lazy chunk loads after
    // navigation). The spotlight must find the anchor without the user
    // scrolling — this regression covers the "Looking for this step" flake.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/\/object\//, { timeout: 15000 });
    await expect(page.getByText('Your finished images')).toBeVisible({ timeout: 15000 });

    // Fallback card must never be the thing on screen; the spotlight arrives
    // once the lazy anchor mounts (polled, no scroll required).
    await expect(page.getByText('Looking for this step')).toHaveCount(0);
    await expect(page.locator('.nbl-tour-card')).toBeVisible();
  });
});
