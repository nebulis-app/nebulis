/**
 * Docker lab, browser tier: link a folder in the real Docker image through the app's own wizard, then look at what
 * the user sees: the library, the calendar, a night shot at two exposures, the Sun, the Calibration Library and
 * Settings. The folder is a Tomas-style library (see tests/lab/linkedFolders.lab.test.ts for the same tree through the API).
 *
 * `docker cp` leaves the files owned by root, which the server (running as `node`) cannot write, the same position as
 * a share mounted read-only. The spec proves the source is left exactly as found.
 *
 * Needs the stack: `npm run lab:up`. Run: `npm run test:e2e:docker`.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { APP, stackIsUp, resetApp, copyIntoApp, hashesIn, sh } from '../lab/labStack';
import { API, signIn, openApp } from './dockerApp';

const ROOT = process.cwd();
const TREE = path.join(ROOT, 'tests/fixtures/import-lab/generated/upload/G-linked-library');
const SHARE = '/linked/G-ui';

test.describe.configure({ mode: 'serial' });

let token = '';
let shareHashes: Record<string, string> = {};
let shareListing = '';
const listing = () => sh(APP, `cd '${SHARE}' && find . | sort`);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (!(await stackIsUp())) throw new Error('The Docker lab is not running. Start it with: npm run lab:up');
  if (!fs.existsSync(TREE)) execFileSync('npx', ['tsx', 'tests/fixtures/import-lab/generate.ts'], { cwd: ROOT, stdio: 'ignore' });
  await resetApp();
  copyIntoApp(TREE, SHARE);
  shareHashes = hashesIn(SHARE);
  shareListing = listing();
  token = await signIn();
});

/** Link Data, browse to the folder by path, keep sub-frames on and measure them at night, then link. */
async function linkTheShare(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Upload Files' }).click();
  await page.getByRole('button', { name: /^Link Data/ }).click();
  await page.getByPlaceholder(/Astrophotography/).fill(SHARE);
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('What should come in?')).toBeVisible();
  await page.getByLabel(/Include subframes/).check();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText(/Nothing will be copied/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('M31 · Andromeda Galaxy')).toBeVisible();
  await page.getByLabel('Label for this link').fill('Docker share');
  await page.getByRole('button', { name: 'Continue' }).click();
  // The last step: the refresh schedule, and the nightly measurement of the sub-frames.
  await page.getByRole('checkbox', { name: /Measure its sub-frames at night/ }).check();
  await page.getByRole('button', { name: 'Link folder' }).click();
  await expect(page.getByText('Folder linked')).toBeVisible({ timeout: 60_000 });
}

test('link the share through the wizard: nothing is copied and the share is left as found', async ({ page }) => {
  await openApp(page, token);
  await linkTheShare(page);
  expect(hashesIn(SHARE)).toEqual(shareHashes);
  expect(listing()).toBe(shareListing);
  expect(sh(APP, "find /app/data/library -name 'Stacked_*' | wc -l").trim()).toBe('0');
});

test('every linked night is on the Observations list, and calibration folders are not objects', async ({ page }) => {
  await openApp(page, token, '/observations');
  await page.getByRole('button', { name: 'List' }).click();
  await expect(page.getByRole('row')).toHaveCount(6);   // header + M31 x3, NGC 7000, Sun
  for (const [object, date] of [['M31', '2026-10-03'], ['M31', '2026-10-04'], ['M31', '2026-10-07'], ['NGC7000', '2026-10-05'], ['Sun', '2026-10-06']]) {
    await expect(page.locator(`a[href="/observations/${object}/${date}"]`)).toHaveCount(1);
  }
});

test('a night shot at two exposures opens into one row per setting', async ({ page }) => {
  await openApp(page, token, '/object/M31');
  await page.getByRole('tab', { name: /^Nights/ }).click();
  await expect(page.getByRole('link', { name: /Open night/ })).toHaveCount(3);

  // Only the night with two exposure settings offers to open up.
  const toggles = page.getByRole('button', { name: /exposure settings/ });
  await expect(toggles).toHaveCount(1);
  await expect(toggles).toHaveText('Show 2 exposure settings');
  await toggles.click();
  await expect(page.getByRole('button', { name: 'Hide exposure settings' })).toHaveAttribute('aria-expanded', 'true');
  // One row per setting, each named by its exposure.
  const settings = page.locator('li ul li');
  await expect(settings).toHaveCount(2);
  await expect(settings.filter({ hasText: '10.0s' })).toHaveCount(1);
  await expect(settings.filter({ hasText: '20.0s' })).toHaveCount(1);
});

test('the Sun is imaged by day, so its page says Days', async ({ page }) => {
  await openApp(page, token, '/object/Sun');
  await expect(page.getByRole('tab', { name: /^Days/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Nights/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Days/ }).click();
  await expect(page.getByRole('link', { name: /Open day/ })).toHaveCount(1);
});

/** The observation page folds its object, conditions and map panels away until opened. */
async function openSessionDetails(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^Session details/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test("a Sun observation says day on its own page, and a deep-sky night still says night", async ({ page }) => {
  await openApp(page, token, '/observations/Sun/2026-10-06');
  await openSessionDetails(page);
  await expect(page.getByText(/No conditions were recorded for this day\./)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/recorded for this night/)).toHaveCount(0);

  await openApp(page, token, '/observations/M31/2026-10-04');
  await openSessionDetails(page);
  await expect(page.getByText(/No conditions were recorded for this night\./)).toBeVisible({ timeout: 30_000 });
});

test('calibration frames in the share are in the Calibration Library, read in place and never deletable', async ({ page }) => {
  await openApp(page, token, '/calibrations');
  await expect(page.getByText('Read from your linked folder where it is. Nebulis never changes or deletes these files.').first()).toBeVisible({ timeout: 30_000 });
  // A section for each kind of frame in the share: bias, darks and flats, and the Dwarf's mixed CALI_FRAME.
  for (const title of ['Darks', 'Bias', 'Flats', 'Calibration (mixed)']) {
    await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /ZIP/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Delete/i })).toHaveCount(0);
  await expect(page.getByTitle('Delete')).toHaveCount(0);
});

test('Settings lists the link, with the nightly measurement on, and Edit keeps it', async ({ page }) => {
  await openApp(page, token, '/settings?tab=storage&section=linked');
  await expect(page.getByText('Docker share', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  const box = page.getByRole('checkbox', { name: /Measure its sub-frames at night/ });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);

  const sources = ((await (await fetch(`${API}/library/sources`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data: { sources: Array<{ importOptions: string }> } }).data.sources;
  expect(JSON.parse(sources[0].importOptions)).toMatchObject({ importSubFrames: true, analyzeFrames: false });
});

test('Settings save when no sky mask is set (the "288 items" error)', async ({ page }) => {
  await openApp(page, token, '/settings');
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('button', { name: '°C' }).click();
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText(/Save failed/)).toHaveCount(0);
  await expect.poll(async () => {
    const res = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${token}` } });
    return ((await res.json()) as { data: { temperatureUnit: string } }).data.temperatureUnit;
  }).toBe('celsius');
});
