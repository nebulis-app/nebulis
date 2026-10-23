import { test, expect } from '@playwright/test';
import { mockAllRoutes, ok, json } from './fixtures/mocks';

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
    for (const label of ['All', 'Galaxies', 'Nebulae', 'Clusters']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // Hide blocked, the sort order and the scope (wishlist / not imaged) live in the View menu.
    await page.getByRole('button', { name: /view options/i }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /hide blocked/i })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: /not imaged yet/i })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: /wishlist/i })).toBeVisible();
  });

  test('search narrows the library to matching targets', async ({ page }) => {
    await page.getByPlaceholder(/search/i).fill('Pleiades');
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy')).not.toBeVisible();
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
    // The reference photo is rendered with a translated alt and no visible
    // "Reference image" label (same compact treatment as
    // WishlistObjectModal/CatalogObjectModal), so match it by accessible name.
    await expect(page.getByRole('img', { name: /reference image/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /close details/i })).toBeVisible();
  });

  // The chevron on a library row expands a condensed altitude chart inline,
  // as an alternative to opening the full details modal. Distinct from the
  // modal's own chart (covered by "scrubbing the altitude chart..." below):
  // this one lives in the row itself and several can be open at once.
  test.describe('library row altitude chevron', () => {
    test('expands an inline altitude chart without opening the details modal', async ({ page }) => {
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(0);

      await page.getByRole('button', { name: 'Show altitude and filters for Orion Nebula', exact: true }).click();

      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(1);
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });

    test('is a toggle: clicking again collapses the chart', async ({ page }) => {
      const toggle = page.getByRole('button', { name: 'Show altitude and filters for Orion Nebula', exact: true });
      await toggle.click();
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(1);

      await page.getByRole('button', { name: 'Hide altitude and filters for Orion Nebula', exact: true }).click();
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(0);
    });

    test('expanding one row leaves the others collapsed', async ({ page }) => {
      await page.getByRole('button', { name: 'Show altitude and filters for Orion Nebula', exact: true }).click();
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(1);

      await page.getByRole('button', { name: 'Show altitude and filters for Pleiades', exact: true }).click();
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(2);

      await page.getByRole('button', { name: 'Hide altitude and filters for Orion Nebula', exact: true }).click();
      await expect(page.locator('svg.cursor-crosshair')).toHaveCount(1);
      // Pleiades' chart is the one still open.
      await expect(page.getByRole('button', { name: 'Hide altitude and filters for Pleiades', exact: true })).toBeVisible();
    });
  });

  // Scrubbing the altitude chart drives the sky tracker's moment, and the
  // caption under the chart swaps between the short scrubbed wording and the
  // longer "(highest tonight)" default. Both states have to occupy the same
  // height: this modal is vertically centered, so a line of difference there
  // slid the whole dialog up and down under the cursor while scrubbing.
  test('scrubbing the altitude chart does not move the details modal', async ({ page }) => {
    // Tall enough that the modal is not already clamped to its 92vh ceiling,
    // where the body scrolls and would hide the shift.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole('button', { name: 'Show details for Orion Nebula', exact: true }).click();
    const panel = page.locator('div.relative.flex.flex-col.rounded-2xl');
    await expect(panel).toBeVisible();

    const rest = await panel.boundingBox();
    expect(rest).not.toBeNull();

    const chart = panel.locator('svg.cursor-crosshair').first();
    const chartBox = await chart.boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(chartBox!.x + chartBox!.width * 0.5, chartBox!.y + chartBox!.height * 0.5);

    // The caption did switch to the scrubbed wording ("Shown at 03:00 · drag…";
    // the default variant reads "Shown at 03:00 (highest tonight) · drag…")...
    await expect(page.getByText(/Shown at \d{2}:\d{2} · drag the chart/)).toBeVisible();

    // ...and the modal's box is unchanged.
    const scrubbed = await panel.boundingBox();
    expect(Math.abs(scrubbed!.height - rest!.height)).toBeLessThan(1);
    expect(Math.abs(scrubbed!.y - rest!.y)).toBeLessThan(1);
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
      // The reference photo is rendered with a translated alt and no visible
    // "Reference image" label (same compact treatment as
    // WishlistObjectModal/CatalogObjectModal), so match it by accessible name.
    await expect(page.getByRole('img', { name: /reference image/i })).toBeVisible();
    });
  });

  test('the hero collapses to one row and stays collapsed after a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse header', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Expand header', exact: true })).toBeVisible();
    // The title and the verdict survive the collapse; only the long form goes.
    await expect(page.getByRole('heading', { name: 'Planner', level: 1 })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand header', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Expand header', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collapse header', exact: true })).toBeVisible();
  });

  test('an empty night offers the two ways to start, and sharing waits for a plan', async ({ page }) => {
    await expect(page.getByText('Nothing planned for this night yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeDisabled();
    // No "More" menu any more: nothing to copy here, so no copy button either.
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /copy last night/i })).toHaveCount(0);
  });

  test('a planned night puts copy and share in the schedule header', async ({ page }) => {
    const now = new Date().toISOString();
    await page.route('**/api/planned-sessions**', route => {
      if (route.request().method() !== 'GET') return route.fulfill(json(ok({ id: 1 })));
      return route.fulfill(json(ok([{
        id: 1, objectId: 'M42', objectName: 'Orion Nebula', ra: 83.8, dec: -5.4,
        startTime: now, endTime: now, notes: '', framingSetup: null, createdAt: now, updatedAt: now,
      }])));
    });
    await page.reload();
    await expect(page.getByRole('button', { name: /copy last night/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
    await expect(page.getByText('Nothing planned for this night yet.')).toHaveCount(0);
  });

  test('the rating key explains the night strip', async ({ page }) => {
    await page.getByRole('button', { name: 'Rating key', exact: true }).click();
    const key = page.getByRole('dialog', { name: 'Rating key' });
    await expect(key).toContainText('Forecast rating');
    await expect(key).toContainText('Blocks planned');
    await expect(key).toContainText('Moon phase');
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
