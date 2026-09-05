import { test, expect } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

// The planner is a split-pane layout: a searchable object library on the left
// and a dusk-to-dawn schedule timeline on the right. Targets are dragged from
// the library onto the timeline. These tests cover the library pane, the
// details modal, and the below-horizon search backfill.
test.describe('Planner Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/planner');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /planner/i })).toBeVisible();
  });

  test('lists tonight\'s observable targets in the library', async ({ page }) => {
    await expect(page.getByText('Orion Nebula').first()).toBeVisible();
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy').first()).toBeVisible();
  });

  test('shows the search box and filter controls', async ({ page }) => {
    await expect(page.getByPlaceholder(/search/i)).toBeVisible();
    for (const label of ['All', 'Galaxies', 'Nebulae', 'Clusters', 'Wishlist']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /hide blocked/i })).toBeVisible();
  });

  test('search narrows the library to matching targets', async ({ page }) => {
    await page.getByPlaceholder(/search/i).fill('Pleiades');
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy')).not.toBeVisible();
  });

  test('wishlist filter shows only wishlisted targets', async ({ page }) => {
    // M45 (Pleiades) is the only wishlisted target in the mock.
    await page.getByRole('button', { name: 'Wishlist', exact: true }).click();
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('galaxies filter shows only galaxies', async ({ page }) => {
    await page.getByRole('button', { name: 'Galaxies', exact: true }).click();
    await expect(page.getByText('Whirlpool Galaxy').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('observable targets are draggable onto the timeline', async ({ page }) => {
    // @dnd-kit marks draggable rows with aria-roledescription="draggable".
    await expect(
      page.locator('[aria-roledescription="draggable"]', { hasText: 'Orion Nebula' }),
    ).toBeVisible();
  });

  test('opens the object details modal from a library row', async ({ page }) => {
    await page.getByRole('button', { name: 'Show details for Orion Nebula', exact: true }).click();
    await expect(page.getByText('Reference image')).toBeVisible();
    await expect(page.getByRole('button', { name: /close details/i })).toBeVisible();
  });

  test('shows the moon summary and sky-map control', async ({ page }) => {
    // The illumination no longer repeats the word "Moon": the block is already
    // labelled, and the line has to leave room for the rise/set times, which
    // were being truncated mid-number when everything shared one line.
    await expect(page.getByText('Moon', { exact: true })).toBeVisible();
    await expect(page.getByText(/42% lit/i)).toBeVisible();
    // The visible-sky editor sits with the night picker, not on the night
    // panel: it is a property of the observing site, not of tonight.
    await expect(page.getByRole('button', { name: /visible sky/i })).toBeVisible();
  });

  // The planner reads the same forecast the Sky Forecast page does, and shows
  // the full hour-by-hour picture in a popup rather than sending you to
  // another page for it.
  test.describe('night weather popup', () => {
    test('the rating opens the full forecast for the night', async ({ page }) => {
      await page.getByRole('button', { name: /open the hour-by-hour forecast/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/dark hours/i)).toBeVisible();
      await expect(dialog.getByText(/best window/i)).toBeVisible();
    });

    test('an hour on the weather gutter opens its breakdown', async ({ page }) => {
      await page.locator('button[aria-label^="Forecast for"]').nth(4).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Landing on an hour means its score breakdown is already open.
      await expect(dialog.getByText(/transparency/i).first()).toBeVisible();
    });

    test('the popup closes again', async ({ page }) => {
      await page.getByRole('button', { name: /open the hour-by-hour forecast/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: /close weather/i }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });

  // The feature under test: an object that never clears the horizon tonight is
  // dropped from /planner/tonight, but a search must still surface it from the
  // full catalog as a dimmed, non-draggable "not observable" row.
  test.describe('below-horizon search backfill', () => {
    test('surfaces a below-horizon object under a "not observable" heading', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await expect(page.getByText(/not observable on this night/i)).toBeVisible();
      await expect(page.getByText('47 Tucanae')).toBeVisible();
    });

    test('the below-horizon row is not draggable', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await expect(page.getByText('47 Tucanae')).toBeVisible();
      await expect(
        page.locator('[aria-roledescription="draggable"]', { hasText: '47 Tucanae' }),
      ).toHaveCount(0);
    });

    test('the below-horizon row still opens details', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await page.getByRole('button', { name: 'Show details for 47 Tucanae', exact: true }).click();
      await expect(page.getByText('Reference image')).toBeVisible();
    });
  });

  test('prompts for location when none is set', async ({ page }) => {
    // locationSet:false makes the planner render the location empty-state
    // instead of the library/timeline panes.
    await page.route('**/api/planner/tonight**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({
          locationSet: false,
          targets: [],
          nightStart: null,
          nightEnd: null,
          timelineStart: null,
          timelineEnd: null,
          moonIllumination: 0,
          moonPhase: 'Unknown',
          observerTimezone: null,
        })),
      }));
    await page.goto('/planner');
    await expect(page.getByText(/location not set/i)).toBeVisible();
  });
});
