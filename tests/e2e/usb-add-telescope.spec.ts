import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * Adding a USB telescope in the Add Smart Telescope modal. With two telescopes of one model plugged in, guessing which drive is
 * which is how a telescope ends up on the wrong one, so the modal picks a drive only when there is nothing to choose between, and
 * never offers to put a new telescope on a drive another one already owns.
 */

const drive = (over: Record<string, unknown>) => ({
  mountPath: '/Volumes/EMMC Images', volumeName: 'EMMC Images', looksLikeSeestar: true, looksLikeDwarf: false, looksLikeAsiair: false,
  alreadyKnownDeviceId: null, alreadyKnownProfileId: null, alreadyKnownProfileName: null,
  totalBytes: 64_000_000_000, freeBytes: 20_000_000_000, writable: true, objectFolders: 12, newestActivity: '2026-10-28T03:00:00Z', ...over,
});

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Opened { dialog: ReturnType<Page['getByRole']>; probes: Record<string, unknown>[]; creates: Record<string, unknown>[] }

/** Opens Add Smart Telescope on the Connect step. `usb` switches it to the USB cable option. */
async function openConnectStep(page: Page, drives: unknown[], opts: { usb?: boolean; probe?: Record<string, unknown>; create?: { status: number; body: unknown } } = {}): Promise<Opened> {
  const probes: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  await mockAllRoutes(page);
  await page.route('**/api/telescopes', async r => {
    if (r.request().method() !== 'POST') return r.fulfill(json(ok([MOCK.telescopes[0]])));
    creates.push(r.request().postDataJSON() as Record<string, unknown>);
    const res = opts.create ?? { status: 200, body: ok({ ...MOCK.telescopes[0], id: 'new-scope' }) };
    return r.fulfill(json(res.body, res.status));
  });
  await page.route('**/api/telescopes/drives', r => r.fulfill(json(ok({ drives }))));
  await page.route('**/api/telescopes/probe-identity', r => {
    probes.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill(json(ok({ deviceId: 'probed', alreadyKnownProfileId: null, alreadyKnownProfileName: null, wrote: true, readonly: false, ...opts.probe })));
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Telescopes' }).click();
  await page.getByRole('button', { name: 'Add smart telescope' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Next' }).click();
  if (opts.usb !== false) await dialog.getByRole('button', { name: 'USB cable' }).click();
  return { dialog, probes, creates };
}

const pathBox = (dialog: Opened['dialog']) => dialog.getByPlaceholder('Or paste a custom path...');

/** From the Connect step to the final step's Add Telescope button, and press it. */
async function finish(dialog: Opened['dialog']) {
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Add Telescope' }).click();
}

test.describe('Choosing a USB drive in Add Smart Telescope', () => {
  test('picks the drive for you when there is exactly one and nobody owns it', async ({ page }) => {
    const { dialog } = await openConnectStep(page, [drive({})]);
    await expect(pathBox(dialog)).toHaveValue('/Volumes/EMMC Images');
  });

  test('picks nothing when two drives are plugged in, and takes the one you click', async ({ page }) => {
    const { dialog } = await openConnectStep(page, [
      drive({ mountPath: '/Volumes/EMMC Images', volumeName: 'EMMC Images', objectFolders: 41 }),
      drive({ mountPath: '/Volumes/EMMC Images 1', volumeName: 'EMMC Images 1', objectFolders: 12 }),
    ]);
    await expect(dialog.getByText('41 object folders')).toBeVisible();
    await expect(pathBox(dialog)).toHaveValue('');
    await dialog.getByRole('button', { name: /EMMC Images 1/ }).click();
    await expect(pathBox(dialog)).toHaveValue('/Volumes/EMMC Images 1');
  });

  test('does not pick a lone drive that already belongs to another telescope', async ({ page }) => {
    const { dialog } = await openConnectStep(page, [drive({ alreadyKnownDeviceId: 'id-s30', alreadyKnownProfileId: 'scope-2', alreadyKnownProfileName: 'S30 Pro' })]);
    await expect(dialog.getByText('Already added as S30 Pro')).toBeVisible();
    await expect(pathBox(dialog)).toHaveValue('');
  });
});

test.describe('Putting a new telescope on a drive another telescope owns', () => {
  const owned = drive({ alreadyKnownDeviceId: 'id-s30', alreadyKnownProfileId: 'scope-2', alreadyKnownProfileName: 'S30 Pro' });

  test('asks about merging, and does not offer to create a second telescope on that drive', async ({ page }) => {
    const { dialog, creates } = await openConnectStep(page, [owned]);
    await dialog.getByRole('button', { name: /EMMC Images/ }).click();
    await finish(dialog);

    await expect(dialog.getByText('Same telescope as S30 Pro?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add to S30 Pro' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create new anyway' })).toHaveCount(0);
    expect(creates).toHaveLength(0);
  });

  test('still offers "Create new anyway" for a Wi-Fi telescope, which pairs with no drive', async ({ page }) => {
    const { dialog } = await openConnectStep(page, [], { usb: false, probe: { alreadyKnownProfileId: 'scope-2', alreadyKnownProfileName: 'S30 Pro' } });
    await dialog.getByRole('textbox').first().fill('192.168.1.50');
    await finish(dialog);

    await expect(dialog.getByText('Same telescope as S30 Pro?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create new anyway' })).toBeVisible();
  });

  test('shows the server\'s refusal when it will not create the telescope on a drive that was taken in the meantime', async ({ page }) => {
    const refusal = { ok: false, error: { code: 'DRIVE_BELONGS_TO_OTHER', message: 'That drive belongs to S30 Pro. Pick S50\'s own drive, or unplug the other one first.' } };
    const { dialog, creates } = await openConnectStep(page, [drive({})], { create: { status: 409, body: refusal } });
    await finish(dialog);

    await expect(dialog.getByText(/That drive belongs to S30 Pro/)).toBeVisible();
    expect(creates).toHaveLength(1);
  });
});

test.describe('Marking the drive while adding', () => {
  test('asks the server to probe with identity tracking on by default, so the probe may mark the drive', async ({ page }) => {
    const { dialog, probes } = await openConnectStep(page, [drive({})]);
    await finish(dialog);
    await expect.poll(() => probes.length).toBe(1);
    expect(probes[0]).toMatchObject({ trackDeviceIdentity: true, transport: { kind: 'local', localPath: '/Volumes/EMMC Images' } });
  });
});
