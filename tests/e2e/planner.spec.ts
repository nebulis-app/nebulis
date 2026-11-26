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

  test('shows the moon summary, and no visible-sky button on the page', async ({ page }) => {
    // The banner starts collapsed, where the Moon is a small picture with its
    // illumination beside the verdict.
    // (The wide-screen night picker holds a second copy, hidden at this width.)
    await expect(page.getByText(/42% lit/i).locator('visible=true')).toBeVisible();
    // Expanded, the Moon has a block of its own. The illumination no longer
    // repeats the word "Moon": the block is already labelled, and the line has
    // to leave room for the rise/set times.
    await page.getByRole('button', { name: 'Expand header', exact: true }).click();
    await expect(page.getByText('Moon', { exact: true })).toBeVisible();
    await expect(page.getByText(/42% lit/i)).toBeVisible();
    // The visible-sky mask is a property of the observing site, so it is edited
    // in Settings, Sites, and not from the planner.
    await expect(page.getByRole('button', { name: /visible sky/i })).toHaveCount(0);
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

  test('the hero starts collapsed to one row, and keeps the choice after a reload', async ({ page }) => {
    // Collapsed is the working layout, so it is where the page starts.
    await expect(page.getByRole('button', { name: 'Expand header', exact: true })).toBeVisible();
    // The title stays for screen readers and the verdict is on the row.
    await expect(page.getByRole('heading', { name: 'Planner', level: 1 })).toBeAttached();

    await page.getByRole('button', { name: 'Expand header', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collapse header', exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse header', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Collapse header', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Expand header', exact: true })).toBeVisible();
  });

  test('an empty night has no start-up row, and sharing waits for a plan', async ({ page }) => {
    await expect(page.getByText('Nothing planned for this night yet.')).toHaveCount(0);
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
  });

  test.describe('comets tab', () => {
    // Tonight's hourly positions: the comet drifts 0.1 h of RA an hour, so a block's position depends on its time.
    function cometData(enabled = true) {
      const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
      const tonight = Array.from({ length: 12 }, (_, i) => ({
        t: new Date(t0 + i * 3_600_000).toISOString(), ra: 10 + i * 0.1, dec: 20 + i * 0.05, az: 120 + i * 10, alt: 30 + i, mag: 6.1,
      }));
      const best = new Date(t0 + 4 * 3_600_000).toISOString();
      const night = (dayOffset: number, alt: number, observable: boolean) => ({
        start: new Date(t0 + dayOffset * 86_400_000).toISOString(), end: new Date(t0 + dayOffset * 86_400_000 + 8 * 3_600_000).toISOString(),
        maxAlt: alt, bestTime: best, magnitude: 6.1, ra: 10.4, dec: 20.2, moonIllumination: 30, moonVerdict: 'ok', observable,
      });
      return ok({
        enabled,
        locationSet: true,
        bodies: enabled ? [
          {
            body: { designation: 'C/2023 A3', kind: 'comet', label: 'C/2023 A3 (Tsuchinshan-ATLAS)', source: 'watchlist', libraryObjectId: null },
            status: 'ok', message: null,
            target: {
              id: 'C/2023 A3', ngcName: 'C/2023 A3', name: 'C/2023 A3 (Tsuchinshan-ATLAS)', type: 'Comet', typeCode: 'Comet', constellation: null,
              magnitude: 6.1, majorAxisArcmin: null, ra: 10.4, dec: 20.2, commonNames: ['C/2023 A3 (Tsuchinshan-ATLAS)'], aliases: [],
              altNow: 31, azNow: 130, maxAlt: 41, maxAltTime: best, risesAt: tonight[0].t, setsAt: tonight[11].t,
              isInWishlist: false, isAlreadyImaged: false, libraryObjectId: null,
            },
            nights: [night(0, 41, true), night(1, 43, true)],
            tonight,
          },
          {
            body: { designation: '12P', kind: 'comet', label: '12P/Pons-Brooks', source: 'library', libraryObjectId: '12P_Pons-Brooks' },
            status: 'ok', message: null, target: null, nights: [night(0, 3, false), night(3, 25, true)], tonight: [],
          },
          {
            body: { designation: 'C/2099 Y9', kind: 'comet', label: 'C/2099 Y9', source: 'watchlist', libraryObjectId: null },
            status: 'not-found', message: 'Horizons knows no body by that designation', target: null, nights: [], tonight: [],
          },
        ] : [],
      });
    }

    async function openComets(page: import('@playwright/test').Page, enabled = true) {
      const posted: { comets: unknown[]; sessions: Record<string, unknown>[] } = { comets: [], sessions: [] };
      await page.route('**/api/planner/comets**', route => {
        if (route.request().method() === 'POST') {
          posted.comets.push(route.request().postDataJSON());
          return route.fulfill(json(ok({ designation: 'C/2023 A3', kind: 'comet', label: 'C/2023 A3', source: 'watchlist', libraryObjectId: null })));
        }
        return route.fulfill(json(cometData(enabled)));
      });
      await page.route('**/api/planned-sessions**', route => {
        if (route.request().method() === 'POST') {
          posted.sessions.push(route.request().postDataJSON());
          return route.fulfill(json(ok({ id: 77, ...route.request().postDataJSON() })));
        }
        return route.fulfill(json(ok([])));
      });
      await page.reload();
      await page.getByRole('button', { name: 'Comets', exact: true }).click();
      return posted;
    }

    test('lists tonight, the next nights, and what Horizons does not know; only comets in the list', async ({ page }) => {
      await openComets(page);
      const panel = page.locator('[data-comets-panel]');
      await expect(panel.locator('[data-comet="C/2023 A3"]')).toContainText(/Tonight: up to 41° at \d{2}:\d{2}, magnitude 6\.1/);
      await expect(panel.locator('[data-comet="12P"]')).toContainText('Not high enough tonight. Next:');
      await expect(panel.locator('[data-comet="12P"]').getByRole('link', { name: 'In your library' })).toHaveAttribute('href', '/object/12P_Pons-Brooks');
      await expect(panel.locator('[data-comet="C/2099 Y9"]')).toContainText('JPL Horizons knows no body by that designation.');
      await expect(page.locator('button[aria-label="Add C/2023 A3 (Tsuchinshan-ATLAS) to the schedule"]')).toBeVisible();
      await expect(page.getByText('M42 - Orion Nebula')).toHaveCount(0);
    });

    test('adds a comet by designation', async ({ page }) => {
      const posted = await openComets(page);
      await page.getByLabel('Add a comet or asteroid').fill('12P/Pons-Brooks');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect.poll(() => posted.comets.length).toBe(1);
      expect(posted.comets[0]).toEqual({ input: '12P/Pons-Brooks' });
    });

    test("a comet's block takes the comet's position at the block's middle", async ({ page }) => {
      const posted = await openComets(page);
      await page.locator('button[aria-label="Add C/2023 A3 (Tsuchinshan-ATLAS) to the schedule"]').click();
      await expect.poll(() => posted.sessions.length).toBe(1);
      const block = posted.sessions[0] as { ra: number; dec: number; startTime: string; endTime: string };
      const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
      const middle = (new Date(block.startTime).getTime() + new Date(block.endTime).getTime()) / 2;
      const hours = (middle - t0) / 3_600_000;
      expect(block.ra).toBeCloseTo(10 + hours * 0.1, 3);
      expect(block.dec).toBeCloseTo(20 + hours * 0.05, 3);
    });

    test('says how to turn it on when the setting is off', async ({ page }) => {
      await openComets(page, false);
      await expect(page.locator('[data-comets-panel]')).toContainText('Turn on Comets and asteroids in Settings → Library');
    });
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
