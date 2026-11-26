import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK, json, ok } from './fixtures/mocks';

/**
 * A comet in the library has no catalog position, so its page answers "can I shoot it tonight?" from its ephemeris
 * (the planner's comet list, which includes every library comet) and links to JPL's page for it.
 */
const COMET = {
  ...MOCK.objects[0],
  id: 'C2023A3', catalogId: null, folderName: 'C2023A3', name: 'C/2023 A3', type: 'Comet', constellation: null,
  description: null, magnitude: null, ra: null, dec: null,
  thumbnailUrl: '/api/library/objects/C2023A3/thumbnail', sessionsUrl: '/api/library/objects/C2023A3/sessions',
  filesUrl: '/api/library/objects/C2023A3/files', subFramesUrl: '/api/library/objects/C2023A3/subs',
};

function comets(enabled: boolean) {
  const best = new Date(Date.now() + 2 * 3_600_000).toISOString();
  return ok({
    enabled,
    locationSet: true,
    bodies: [{
      body: { designation: 'C/2023 A3', kind: 'comet', label: 'C2023A3', source: 'library', libraryObjectId: 'C2023A3' },
      status: enabled ? 'ok' : 'idle', message: null,
      target: enabled ? { id: 'C/2023 A3', name: 'C2023A3', type: 'Comet', ra: 14.9, dec: 0.2, maxAlt: 41, maxAltTime: best } : null,
      nights: enabled ? [{ start: best, end: best, maxAlt: 41, bestTime: best, magnitude: 6.1, ra: 14.9, dec: 0.2, moonIllumination: 20, moonVerdict: 'ok', observable: true }] : [],
      tonight: [],
    }],
  });
}

async function openComet(page: import('@playwright/test').Page, enabled: boolean) {
  await mockAllRoutes(page);
  await page.route('**/api/library/objects', r => r.fulfill(json(ok([...MOCK.objects, COMET]))));
  await page.route('**/api/library/objects/C2023A3/sessions', r => r.fulfill(json(ok([]))));
  await page.route('**/api/library/objects/C2023A3', r => r.fulfill(json(ok(COMET))));
  await page.route('**/api/planner/comets**', r => r.fulfill(json(comets(enabled))));
  await page.goto('/object/C2023A3');
}

test.describe('Object page: a comet', () => {
  test('says where it is tonight and links to its ephemeris and the planner', async ({ page }) => {
    await openComet(page, true);
    const panel = page.locator('[data-comet-panel]').first();
    await expect(panel).toContainText(/Tonight: up to 41° at \d{2}:\d{2}, magnitude 6\.1/);
    await expect(panel.getByRole('link', { name: 'Ephemeris of C/2023 A3 (JPL)' }))
      .toHaveAttribute('href', 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=C%2F2023%20A3');
    await expect(panel.getByRole('link', { name: 'Plan it' })).toHaveAttribute('href', '/planner');
  });

  test('says how to turn positions on when the setting is off, and still links to the ephemeris', async ({ page }) => {
    await openComet(page, false);
    const panel = page.locator('[data-comet-panel]').first();
    await expect(panel).toContainText('Turn on Comets and asteroids in Settings → Library');
    await expect(panel.getByRole('link', { name: 'Ephemeris of C/2023 A3 (JPL)' })).toBeVisible();
  });
});
