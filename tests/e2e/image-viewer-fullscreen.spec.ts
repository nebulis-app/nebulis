import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * The AstroBin-style fullscreen (immersive) mode: a floating expand button
 * strips the lightbox down to just the picture, edge-to-edge, and hands zoom
 * state through the transition unchanged (see the `immersive` prop doc in
 * src/components/lightbox/LightboxFrame.tsx). Shipped 2025-09-21; had no
 * automated coverage until this file.
 */

const WIDE = 1200;
const TALL = 1800;

function pngResponse() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDE}" height="${TALL}">`
    + `<rect width="100%" height="100%" fill="#123"/></svg>`;
  return { status: 200, contentType: 'image/svg+xml', body: svg };
}

const FILE = {
  name: 'Stacked_295_NGC 1432_10.0s_IRCUT_20250811-052608.jpg',
  size: 5_242_880,
  type: 'image' as const,
  fileType: 'stacked' as const,
  path: 'NGC1432/Stacked_295.jpg',
  exposure: '10.0s',
  filter: 'IRCUT',
  timestamp: '2025-08-11T05:26:08',
  date: '2024-03-15',
  frameCount: 295,
  isThumbnail: false,
  previewable: true,
  downloadUrl: '/api/library/file?path=NGC1432/Stacked_295.jpg',
  thumbUrl: '/api/library/file/thumbnail?path=NGC1432/Stacked_295.jpg',
};

async function openViewer(page: Page) {
  await mockAllRoutes(page);

  await page.route('**/api/library/observations/**', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(ok({
      ...MOCK.observationDetail,
      files: [FILE],
      stackedCount: 1,
      fitsCount: 0,
      subFrameCount: 0,
      processedCount: 0,
    })),
  }));

  await page.route('**/api/library/file**', r => r.fulfill(pngResponse()));
  await page.goto('/observations/M42/2024-03-15');

  const tile = page.locator('img[src*="NGC1432"]:not([aria-hidden="true"])').first();
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const img = dialog.locator('img[alt]:not([aria-hidden="true"])').first();
  await expect
    .poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5000 })
    .toBeGreaterThan(0);

  return { dialog, img };
}

test.describe('Image viewer fullscreen mode', () => {
  test('the fullscreen button expands the picture edge-to-edge and hides the toolbar', async ({ page }) => {
    const { dialog, img } = await openViewer(page);

    // The dialog animates open. Compare the pane with the dialog only once it has stopped, or the two boxes are read at
    // different moments of the animation and disagree.
    let last = '';
    await expect.poll(async () => {
      const box = JSON.stringify(await dialog.boundingBox());
      const same = box === last;
      last = box;
      return same;
    }, { timeout: 5000 }).toBe(true);

    const windowedPane = dialog.locator('[data-lightbox-pane]');
    const windowedPaneBox = await windowedPane.boundingBox();
    const windowedDialogBox = await dialog.boundingBox();
    // The windowed pane has an inset margin, so it never reaches the dialog's
    // own edges.
    expect(windowedPaneBox!.width).toBeLessThan(windowedDialogBox!.width);

    await dialog.getByRole('button', { name: 'View fullscreen' }).click();

    // The whole dialog now fills the viewport, and the pane is flush with it.
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0)
      .toBe(page.viewportSize()!.width);
    const fullscreenPaneBox = await dialog.locator('[data-lightbox-pane]').boundingBox();
    const fullscreenDialogBox = await dialog.boundingBox();
    expect(Math.abs(fullscreenPaneBox!.width - fullscreenDialogBox!.width)).toBeLessThan(1);
    expect(Math.abs(fullscreenPaneBox!.height - fullscreenDialogBox!.height)).toBeLessThan(1);

    // The header, zoom toolbar, and thumbnail strip are gone.
    await expect(dialog.getByRole('button', { name: 'Fit' })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'View fullscreen' })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();

    // The picture itself is still showing.
    await expect(img).toBeVisible();
  });

  test('exiting fullscreen restores the header and toolbar', async ({ page }) => {
    const { dialog } = await openViewer(page);

    await dialog.getByRole('button', { name: 'View fullscreen' }).click();
    await expect(dialog.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Exit fullscreen' }).click();

    await expect(dialog.getByRole('button', { name: 'View fullscreen' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Fit' })).toBeVisible();
  });

  test('Escape while fullscreen backs out to the windowed view, not out of the viewer entirely', async ({ page }) => {
    const { dialog } = await openViewer(page);

    await dialog.getByRole('button', { name: 'View fullscreen' }).click();
    await expect(dialog.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();

    await page.keyboard.press('Escape');

    // Still open, back in windowed chrome.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'View fullscreen' })).toBeVisible();

    // A second Escape does close the whole viewer.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('zoom state carries over unchanged across the fullscreen transition', async ({ page }) => {
    const { dialog, img } = await openViewer(page);

    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await expect
      .poll(async () => Math.round((await img.boundingBox())?.width ?? 0), { timeout: 5000 })
      .toBe(WIDE);

    await dialog.getByRole('button', { name: 'View fullscreen' }).click();

    // 1:1 means one image pixel per screen pixel; that must not reset just
    // because the surrounding chrome (and its inset) disappeared.
    await expect
      .poll(async () => Math.round((await img.boundingBox())?.width ?? 0), { timeout: 5000 })
      .toBe(WIDE);
  });
});
