import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, MOCK, json, ok } from './fixtures/mocks';

/**
 * Rigs and optical trains: each night is tied to the telescope and the optical
 * configuration (Native, Reducer) that shot it, and the Observations list, the
 * object page and the observation page all say so. The server resolves the train
 * (server/lib/library/sessionOptics.ts); these specs pin what the screens do with
 * what it sends.
 */

const scopeA = {
  id: 'scope-a',
  name: 'Scope A',
  model: 'Refractor',
  hostname: '192.168.1.101',
  shareName: '',
  username: '',
  password: '',
  createdAt: '2024-01-01T00:00:00Z',
  kind: 'asiair',
  color: '#3b82f6',
  autoImportEnabled: false,
  autoImportInterval: 30,
  archivedAt: null,
  connectionType: 'smb',
  localPath: '',
  deviceId: null,
  transports: [],
  activeTransportId: null,
  importJpg: true,
  importFits: true,
  importThumbnails: true,
  importSubFrames: true,
  importVideos: false,
  archiveAllFiles: false,
  syncCalibrationFrames: true,
  trackDeviceIdentity: true,
  pinnedTransportId: null,
  activeOpticalConfigId: null,
  opticalConfigs: [
    { id: 'cfg-native', profileId: 'scope-a', name: 'Native', focalLengthMm: 609, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76, createdAt: '2024-01-01T00:00:00Z' },
    { id: 'cfg-red', profileId: 'scope-a', name: 'Reducer 0.75x', focalLengthMm: 456, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76, createdAt: '2024-01-02T00:00:00Z' },
  ],
};

const scopeB = {
  ...scopeA,
  id: 'scope-b',
  name: 'Scope B',
  model: 'Smart scope',
  kind: 'seestar',
  color: '#22c55e',
  opticalConfigs: [],
};

const optics = {
  native: { configId: 'cfg-native', configName: 'Native', focalLengthMm: 609, source: 'fits' as const, fileFocalMm: 609 },
  reducer: { configId: 'cfg-red', configName: 'Reducer 0.75x', focalLengthMm: 456, source: 'manual' as const, fileFocalMm: 456 },
  // No configuration set up on this telescope: only the focal length the FITS recorded.
  bare: { configId: null, configName: null, focalLengthMm: 250, source: null, fileFocalMm: 250 },
};

function observation(id: string, objectId: string, objectName: string, date: string, telescopeId: string, rigKey: string, o: unknown) {
  return {
    id, objectId, objectName, catalogId: objectId, type: 'Galaxy', constellation: 'Orion', date,
    startTime: `${date}T21:00:00Z`, endTime: `${date}T23:00:00Z`,
    fileCount: 4, stackedCount: 1, fitsCount: 3, thumbnailUrl: `/api/library/objects/${objectId}/thumbnail`,
    ra: '05h 35m 17s', dec: '-05° 23′ 28″', hasNotes: false,
    telescopeId, optics: o, rigKey,
  };
}

const observations = [
  observation('M42_2024-03-15', 'M42', 'Orion Nebula', '2024-03-15', 'scope-a', 'scope-a|cfg-native', optics.native),
  observation('M42_2024-02-10', 'M42', 'Orion Nebula', '2024-02-10', 'scope-a', 'scope-a|cfg-red', optics.reducer),
  observation('M31_2024-02-10', 'M31', 'Andromeda Galaxy', '2024-02-10', 'scope-b', 'scope-b|250mm', optics.bare),
];

async function mockRigs(page: Page, telescopes: unknown[] = [scopeA, scopeB]) {
  await mockAdminAuth(page);
  await mockAllRoutes(page);
  await page.route('**/api/telescopes', r => r.fulfill(json(ok(telescopes))));
  await page.route('**/api/library/observations', r => r.fulfill(json(ok(observations))));
}

test.describe('Observations list: rig column and train filter', () => {
  test.beforeEach(async ({ page }) => {
    await mockRigs(page);
    await page.goto('/observations');
    await page.getByRole('button', { name: 'List' }).click();
  });

  test('names each night\'s rig: telescope, train and focal length', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: /rig/i })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Scope A · Native · 609 mm' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Scope A · Reducer 0.75x · 456 mm' })).toBeVisible();
    // A telescope with no configuration shows the focal length its FITS recorded.
    await expect(page.getByRole('cell', { name: 'Scope B · 250 mm' })).toBeVisible();
  });

  test('sorting by Rig groups the nights of one rig together', async ({ page }) => {
    await page.getByRole('button', { name: 'Rig' }).click();
    const rigs = page.getByRole('row').filter({ has: page.getByRole('cell') }).locator('td:nth-child(3)');
    await expect(rigs).toHaveText([
      'Scope A · Native · 609 mm',
      'Scope A · Reducer 0.75x · 456 mm',
      'Scope B · 250 mm',
    ]);
  });

  test('the telescope filter offers each train of a telescope that has several', async ({ page }) => {
    const filter = page.getByLabel('Filter by telescope');
    await expect(filter.locator('option')).toHaveText([
      'All telescopes',
      'Scope A (all trains)',
      'Scope A · Native · 609 mm',
      'Scope A · Reducer 0.75x · 456 mm',
      'Scope B',
    ]);
  });

  test('filtering by one train keeps only that train\'s nights', async ({ page }) => {
    await page.getByLabel('Filter by telescope').selectOption('scope-a|cfg-red');
    await expect(page.getByRole('row')).toHaveCount(2); // header + 1
    await expect(page.getByRole('cell', { name: 'Scope A · Reducer 0.75x · 456 mm' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Scope B · 250 mm' })).toHaveCount(0);
  });

  test('filtering by the telescope as a whole keeps all its trains', async ({ page }) => {
    await page.getByLabel('Filter by telescope').selectOption('scope-a');
    await expect(page.getByRole('row')).toHaveCount(3); // header + 2
    await expect(page.getByRole('cell', { name: 'Scope B · 250 mm' })).toHaveCount(0);
  });
});

test.describe('Observations list: one rig only', () => {
  test('a single telescope with a single train hides the Rig column and the filter', async ({ page }) => {
    const single = { ...scopeB, id: 'scope-1' };
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/telescopes', r => r.fulfill(json(ok([single]))));
    await page.goto('/observations');
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /rig/i })).toHaveCount(0);
    await expect(page.getByLabel('Filter by telescope')).toHaveCount(0);
  });

  test('one telescope with two trains still shows them', async ({ page }) => {
    await mockRigs(page, [scopeA]);
    await page.goto('/observations');
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('columnheader', { name: /rig/i })).toBeVisible();
    await expect(page.getByLabel('Filter by telescope')).toBeVisible();
  });
});

test.describe('Object page: group nights by rig', () => {
  const sessions = [
    { ...MOCK.sessions[0], telescopeId: 'scope-a', optics: optics.native, rigKey: 'scope-a|cfg-native', integrationSec: 5400 },
    { ...MOCK.sessions[1], telescopeId: 'scope-a', optics: optics.reducer, rigKey: 'scope-a|cfg-red', integrationSec: 7200 },
  ];

  test.beforeEach(async ({ page }) => {
    await mockRigs(page);
    await page.route('**/api/library/objects/M42/sessions', r => r.fulfill(json(ok(sessions))));
    await page.route('**/api/library/observations', r => r.fulfill(json(ok(observations))));
    await page.goto('/object/M42?view=nights');
  });

  test('each night card carries its rig', async ({ page }) => {
    await expect(page.getByText('Scope A · Native · 609 mm').first()).toBeVisible();
    await expect(page.getByText('Scope A · Reducer 0.75x · 456 mm').first()).toBeVisible();
  });

  test('By rig splits the nights per rig with a night count and the integration', async ({ page }) => {
    const toggle = page.getByRole('radiogroup', { name: 'Group nights by' });
    await expect(toggle).toBeVisible();
    await toggle.getByRole('radio', { name: 'By rig' }).click();
    await expect(toggle.getByRole('radio', { name: 'By rig' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('1 night · 1h 30m')).toBeVisible();
    await expect(page.getByText('1 night · 2h')).toBeVisible();
  });

  test('the choice is remembered for the next visit', async ({ page }) => {
    const toggle = page.getByRole('radiogroup', { name: 'Group nights by' });
    await toggle.getByRole('radio', { name: 'By rig' }).click();
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: 'Group nights by' }).getByRole('radio', { name: 'By rig' }))
      .toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('Object page: a single rig', () => {
  test('offers no grouping when every night came from one rig', async ({ page }) => {
    await mockRigs(page);
    const same = MOCK.sessions.map(s => ({ ...s, telescopeId: 'scope-a', optics: optics.native, rigKey: 'scope-a|cfg-native' }));
    await page.route('**/api/library/objects/M42/sessions', r => r.fulfill(json(ok(same))));
    await page.goto('/object/M42?view=nights');
    await expect(page.getByRole('heading', { name: 'Observations' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Group nights by' })).toHaveCount(0);
  });
});

test.describe('Observation page: choose the optical train', () => {
  const detail = { ...MOCK.observationDetail, telescopeId: 'scope-a', optics: optics.native, rigKey: 'scope-a|cfg-native' };

  test.beforeEach(async ({ page }) => {
    await mockRigs(page);
    await page.route('**/api/library/observations/**', r => r.fulfill(json(ok(detail))));
    await page.goto('/observations/M42/2024-03-15');
  });

  test('the telescope chip names the train and where it came from', async ({ page }) => {
    const chip = page.getByRole('link', { name: /Scope A/ });
    await expect(chip).toContainText('Scope A');
    await expect(chip).toContainText('Native · 609 mm');
    await expect(chip.getByText(/Native · 609 mm/)).toHaveAttribute('title', 'Matched from the focal length in the FITS');
  });

  test('picking the reducer saves that choice for the night', async ({ page }) => {
    let body: unknown = null;
    await page.route('**/api/library/objects/M42/sessions/2024-03-15/optics', async r => {
      body = r.request().postDataJSON();
      await r.fulfill(json(ok({ updated: true, opticalConfigId: 'cfg-red' })));
    });
    await page.getByRole('button', { name: 'Reassign to a different telescope' }).click();
    await expect(page.getByText('Optical train', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Reducer 0\.75x/ }).click();
    await expect.poll(() => body).toEqual({ opticalConfigId: 'cfg-red' });
  });

  test('Automatic is only available once a train was chosen by hand', async ({ page }) => {
    await page.getByRole('button', { name: 'Reassign to a different telescope' }).click();
    // Nothing was chosen (the train came from the FITS), so going back to automatic is a no-op.
    await expect(page.getByRole('button', { name: /^Automatic/ })).toBeDisabled();
  });

  test('a chosen train can be sent back to Automatic', async ({ page }) => {
    await page.route('**/api/library/observations/**', r => r.fulfill(json(ok({ ...detail, optics: optics.reducer }))));
    await page.goto('/observations/M42/2024-03-15');
    let body: unknown = null;
    await page.route('**/api/library/objects/M42/sessions/2024-03-15/optics', async r => {
      body = r.request().postDataJSON();
      await r.fulfill(json(ok({ updated: true, opticalConfigId: null })));
    });
    await page.getByRole('button', { name: 'Reassign to a different telescope' }).click();
    const auto = page.getByRole('button', { name: /^Automatic/ });
    await expect(auto).toBeEnabled();
    await auto.click();
    await expect.poll(() => body).toEqual({ opticalConfigId: null });
  });

  test('a telescope without configurations shows no train picker', async ({ page }) => {
    await page.route('**/api/library/observations/**', r => r.fulfill(json(ok({ ...detail, telescopeId: 'scope-b', optics: optics.bare, rigKey: 'scope-b|250mm' }))));
    await page.goto('/observations/M42/2024-03-15');
    await page.getByRole('button', { name: 'Reassign to a different telescope' }).click();
    await expect(page.getByText('Reassign to', { exact: true })).toBeVisible();
    await expect(page.getByText('Optical train', { exact: true })).toHaveCount(0);
  });
});
