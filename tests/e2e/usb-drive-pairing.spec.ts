import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * Two telescopes of one model look the same from outside, so picking a USB drive for one of them has to say what is on
 * each drive, must not guess, and has to put the question to the person when the telescope is already paired with a
 * different drive.
 */

const TELESCOPE = {
  ...MOCK.telescopes[0],
  model: 'SeeStar S50 Pro', kind: 'seestar-s50-pro', shareName: 'Seestar', username: 'seestar', password: '', hasPassword: false,
  connectionType: 'smb', autoImportEnabled: true, autoImportInterval: 60, archivedAt: null,
  activeTransportId: 't1', pinnedTransportId: null, sessionCount: 0,
  transports: [{ id: 't1', profileId: 'scope-1', kind: 'smb', priority: 100, hostname: '192.168.1.100', shareName: 'Seestar', username: 'seestar', password: '', localPath: '', lastSeenAt: null, createdAt: '2026-01-01T00:00:00Z' }],
};

const drive = (over: Record<string, unknown>) => ({
  mountPath: '/Volumes/SEESTAR', volumeName: 'SEESTAR', looksLikeSeestar: true, looksLikeDwarf: false, looksLikeAsiair: false,
  alreadyKnownDeviceId: null, alreadyKnownProfileId: null, alreadyKnownProfileName: null,
  totalBytes: 64_000_000_000, freeBytes: 20_000_000_000, writable: true, objectFolders: 12, newestActivity: '2026-10-28T03:00:00Z', ...over,
});

async function openAddUsbTransport(page: Page, drives: unknown[]) {
  await mockAllRoutes(page);
  await page.route('**/api/telescopes', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok([TELESCOPE])) }));
  await page.route('**/api/telescopes/drives', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok({ drives })) }));
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Telescopes' }).click();
  await page.getByTitle('Manage connections').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add transport' }).click();
  await dialog.locator('select').selectOption('local');
  return dialog;
}

test.describe('Picking a USB drive for a telescope', () => {
  test('says what is on each drive, marks the ones that are taken, and never picks one for you', async ({ page }) => {
    const dialog = await openAddUsbTransport(page, [
      drive({ mountPath: '/Volumes/SEESTAR', volumeName: 'SEESTAR', alreadyKnownDeviceId: 'id-s30', alreadyKnownProfileId: 'scope-2', alreadyKnownProfileName: 'S30 Pro', objectFolders: 41 }),
      drive({ mountPath: '/Volumes/SEESTAR 1', volumeName: 'SEESTAR 1', objectFolders: 12, writable: false }),
    ]);

    const first = dialog.getByRole('button', { name: /SEESTAR\s+\/Volumes\/SEESTAR\s/ });
    const second = dialog.getByRole('button', { name: /SEESTAR 1/ });
    await expect(first).toContainText('41 object folders');
    await expect(first).toContainText('Already added as S30 Pro');
    await expect(second).toContainText('12 object folders');
    await expect(second).toContainText('Not paired yet');
    await expect(second).toContainText('Read-only');
    await expect(second).toContainText('20 GB free');

    // With two telescopes plugged in, a guess is how one ends up on the other's drive.
    await expect(dialog.getByPlaceholder('Or paste a custom path...')).toHaveValue('');
    await second.click();
    await expect(dialog.getByPlaceholder('Or paste a custom path...')).toHaveValue('/Volumes/SEESTAR 1');
  });

  test('asks before pairing the telescope with a different drive, and pairs it once confirmed', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    const dialog = await openAddUsbTransport(page, [drive({ mountPath: '/Volumes/SEESTAR 1', volumeName: 'SEESTAR 1' })]);
    await page.route('**/api/telescopes/scope-1/transports', async r => {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      if (body.replaceDrive !== true) {
        return r.fulfill({
          status: 409, contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { code: 'DRIVE_SWAP_NEEDED', message: "Seestar S50 is already paired with the drive at /Volumes/SEESTAR. If you have swapped that drive for this one, confirm the swap to pair this one instead." } }),
        });
      }
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(ok({ id: 't2', profileId: 'scope-1', kind: 'local', priority: 50, hostname: '', shareName: '', username: '', password: '', localPath: '/Volumes/SEESTAR 1', lastSeenAt: null, createdAt: '2026-01-01T00:00:00Z', pairing: { status: 'paired', deviceId: 'new-id', wrote: true } })),
      });
    });

    await dialog.getByRole('button', { name: /SEESTAR 1/ }).click();
    await dialog.getByRole('button', { name: 'Add transport' }).click();

    await expect(dialog.getByText(/already paired with the drive at \/Volumes\/SEESTAR/)).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].replaceDrive).toBeUndefined();

    await dialog.getByRole('button', { name: 'Pair this drive instead' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({ kind: 'local', localPath: '/Volumes/SEESTAR 1', replaceDrive: true });
    await expect(dialog.getByRole('button', { name: 'Pair this drive instead' })).toHaveCount(0);
  });

  test('says so when a drive cannot be marked, because it is then recognised by its path alone', async ({ page }) => {
    const dialog = await openAddUsbTransport(page, [drive({ mountPath: '/Volumes/SEESTAR', writable: false })]);
    await page.route('**/api/telescopes/scope-1/transports', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(ok({ id: 't2', profileId: 'scope-1', kind: 'local', priority: 50, hostname: '', shareName: '', username: '', password: '', localPath: '/Volumes/SEESTAR', lastSeenAt: null, createdAt: '2026-01-01T00:00:00Z', pairing: { status: 'unmarked', reason: 'read-only' } })),
    }));

    await dialog.getByRole('button', { name: /SEESTAR/ }).click();
    await dialog.getByRole('button', { name: 'Add transport' }).click();

    await expect(page.getByText(/read-only, so Nebulis could not mark it/)).toBeVisible();
  });
});
