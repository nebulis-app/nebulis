import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockViewerAuth, MOCK, json, ok } from './fixtures/mocks';

/**
 * Export for stacking: the lights you keep, with the darks, flats, flat darks and
 * bias from the calibration library that match them, as a ZIP for PixInsight WBPP
 * or Siril. The plan is shown before anything is built so missing or doubtful
 * calibration is visible before downloading gigabytes. The matching itself is
 * covered by tests/backend/stackingMatch*.test.ts and stackingExportRoutes.test.ts.
 */

const cal = (type: string, name: string, extra: Record<string, unknown> = {}) => ({
  type, name, scope: null, folderName: name, key: `${type}-${name}`, source: 'matched', fileCount: 20, bytes: 1_000_000,
  exposureSec: 180, gain: 80, binning: 1, sensorTempC: -10, filter: null, capturedAt: '2026-09-01T00:00:00Z', isExpired: false,
  ...extra,
});

/** One filter, one night: darks and flats found, so the plan is complete. */
const completeGroup = {
  id: 'g1', night: '2024-03-15', filter: 'Ha', exposureSec: 180, gain: 80, binning: 1, sensorTempC: -10,
  frames: 40, kept: 37, bytes: 2_000_000_000,
  dark: cal('dark', 'Darks 180s g80'), flat: cal('flat', 'Flats Ha', { filter: 'Ha', deltaDays: 0 }),
  flatDark: cal('flatDark', 'Flat darks 3s'), bias: null, issues: [],
};

/** Same night, a second filter with no darks: an error the person has to see. */
const problemGroup = {
  ...completeGroup, id: 'g2', filter: 'OIII', frames: 30, kept: 30,
  dark: null, flat: null, flatDark: null,
  issues: [
    { code: 'no_dark', severity: 'error' },
    { code: 'no_flat', severity: 'error', params: { filter: 'OIII' } },
  ],
};

function plan(groups: unknown[], totals: Record<string, number> = {}) {
  return {
    objectId: 'M42', nights: ['2024-03-15'], includeNotKept: false, groups,
    unmeasuredByNight: {},
    totals: { lights: 67, excluded: 3, calibrationFrames: 60, bytes: 3_000_000_000, errors: 0, warnings: 0, ...totals },
  };
}

const sessions = MOCK.sessions.map(s => ({ ...s, subFrameCount: 40 }));

/** Everything the dialog and the object page ask for, with the plan swapped per test. */
async function mockStacking(page: Page, thePlan: unknown) {
  const requests: { path: string; body: Record<string, unknown> | null }[] = [];
  await page.route('**/api/library/objects/M42/sessions', r => r.fulfill(json(ok(sessions))));
  // Measured already, so the dialog never offers to measure and the button is not held back.
  await page.route('**/api/library/objects/M42/sessions/*/frame-analysis', r =>
    r.fulfill(json(ok({ objectId: 'M42', date: '', frames: [], reference: null, measured: 0, total: 0, pending: 0, failures: {} }))));
  await page.route('**/api/library/objects/M42/stacking-export/plan', async r => {
    requests.push({ path: 'plan', body: r.request().postDataJSON() });
    await r.fulfill(json(ok(thePlan)));
  });
  await page.route('**/api/library/objects/M42/stacking-export', async r => {
    requests.push({ path: 'export', body: r.request().postDataJSON() });
    await r.fulfill(json(ok({ jobId: 'job-1', filesTotal: 100 })));
  });
  await page.route('**/api/library/download/status/job-1', r =>
    r.fulfill(json(ok({ status: 'running', filesTotal: 100, filesDone: 40, elapsedMs: 1000 }))));
  await page.route('**/api/library/download/status/job-1/cancel', r => r.fulfill(json(ok({ cancelled: true }))));
  return requests;
}

async function openDialog(page: Page) {
  await page.goto('/object/M42');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Export for stacking' }).click();
  await expect(page.getByRole('dialog', { name: 'Export for stacking' })).toBeVisible();
}

test.describe('Export for stacking: the object page entry', () => {
  test('is offered once a night has sub-frames', async ({ page }) => {
    await mockAllRoutes(page);
    await mockStacking(page, plan([completeGroup]));
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Export for stacking' })).toBeVisible();
  });

  test('is missing while no night has sub-frames', async ({ page }) => {
    await mockAllRoutes(page);
    await mockStacking(page, plan([completeGroup]));
    // The shared mock sessions carry no sub-frame count.
    await page.route('**/api/library/objects/M42/sessions', r => r.fulfill(json(ok(MOCK.sessions))));
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Export for stacking' })).toHaveCount(0);
  });
});

test.describe('Export for stacking: the plan', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('shows what matched before anything is built', async ({ page }) => {
    await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    await expect(page.getByText(/67 lights · 60 calibration frames/)).toBeVisible();
    await expect(page.getByText('Calibration complete')).toBeVisible();
    await expect(page.getByText('37 / 40 kept')).toBeVisible();
    for (const row of ['Darks', 'Flats', 'Flat darks']) await expect(page.getByText(row, { exact: true })).toBeVisible();
    await expect(page.getByText('Darks 180s g80')).toBeVisible();
    await expect(page.getByText('Flats Ha')).toBeVisible();
    await expect(page.getByText('same night')).toBeVisible();
    // Flat darks calibrate the flats, so bias is not needed, and the dialog says so.
    await expect(page.getByText('Not needed: flat darks calibrate the flats')).toBeVisible();
  });

  test('says what is missing and where to add it', async ({ page }) => {
    await mockStacking(page, plan([completeGroup, problemGroup], { errors: 2 }));
    await openDialog(page);
    await expect(page.getByText('2 problems')).toBeVisible();
    await expect(page.getByText('No darks at 180s, gain 80, bin 1')).toBeVisible();
    await expect(page.getByText('No flats for OIII')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the calibration library' })).toBeVisible();
    // Problems do not block the export: stackers skip what is missing.
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeEnabled();
  });

  test('warns when flats came from another night', async ({ page }) => {
    const away = { ...completeGroup, issues: [{ code: 'flat_other_night', severity: 'warning', params: { days: 4 } }] };
    await mockStacking(page, plan([away], { warnings: 1 }));
    await openDialog(page);
    await expect(page.getByText(/Shot 4 d from this night/)).toBeVisible();
  });

  test('lists every night with sub-frames, all picked to start with', async ({ page }) => {
    await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    const nights = page.getByRole('group', { name: /Nights/ }).getByRole('checkbox');
    await expect(nights).toHaveCount(2);
    await expect(nights.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(nights.nth(1)).toHaveAttribute('aria-checked', 'true');
  });

  test('unticking a night asks for a new plan for the nights left', async ({ page }) => {
    const requests = await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    await page.getByRole('group', { name: /Nights/ }).getByRole('checkbox').first().click();
    await expect.poll(() => requests.filter(r => r.path === 'plan').at(-1)?.body?.dates).toEqual(['2024-02-10']);
  });

  test('"Include sub-frames not kept" asks for a plan with them in', async ({ page }) => {
    const requests = await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    await page.getByLabel('Include sub-frames not kept').check();
    await expect.poll(() => requests.filter(r => r.path === 'plan').at(-1)?.body?.includeNotKept).toBe(true);
  });
});

test.describe('Export for stacking: building the ZIP', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('defaults to PixInsight WBPP and sends the chosen nights and layout', async ({ page }) => {
    const requests = await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    await expect(page.getByRole('button', { name: 'PixInsight WBPP' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Siril' }).click();
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    await expect.poll(() => requests.find(r => r.path === 'export')?.body).toEqual({
      dates: ['2024-02-10', '2024-03-15'], includeNotKept: false, layout: 'siril',
    });
  });

  test('shows progress while the ZIP builds, and Cancel stops it', async ({ page }) => {
    await mockStacking(page, plan([completeGroup]));
    await openDialog(page);
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    await expect(page.getByRole('progressbar', { name: 'Building the ZIP' })).toBeVisible();
    await expect(page.getByText('40 / 100 files')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeEnabled();
  });

  test('cannot build when there are no lights', async ({ page }) => {
    await mockStacking(page, plan([], { lights: 0, excluded: 0, calibrationFrames: 0, bytes: 0 }));
    await openDialog(page);
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeDisabled();
  });
});

test.describe('Export for stacking: measuring first', () => {
  test('offers to measure nights whose frames have no grade yet', async ({ page }) => {
    await mockAllRoutes(page);
    await mockStacking(page, plan([completeGroup]));
    await page.route('**/api/library/objects/M42/sessions/*/frame-analysis', r => r.fulfill(json(ok({
      objectId: 'M42', date: '', frames: [], reference: null, measured: 0, total: 12, pending: 0, failures: {},
    }))));
    await openDialog(page);
    await expect(page.getByText(/is not measured yet|not measured yet/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Measure 24 sub-frames/ })).toBeVisible();
  });

  test('a viewer is told an admin has to measure them', async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page);
    await mockStacking(page, plan([completeGroup]));
    await page.route('**/api/library/objects/M42/sessions/*/frame-analysis', r => r.fulfill(json(ok({
      objectId: 'M42', date: '', frames: [], reference: null, measured: 0, total: 12, pending: 0, failures: {},
    }))));
    await openDialog(page);
    await expect(page.getByText('An admin can measure it.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Measure \d+ sub-frames/ })).toHaveCount(0);
  });
});
