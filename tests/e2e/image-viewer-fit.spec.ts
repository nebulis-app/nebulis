import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * The viewer's default "Fit" must actually fit.
 *
 * This regressed once in a way that no type or lint check could catch: the
 * observation viewer is mounted closed and returns null until opened, so a
 * mount-time measurement of the image pane found nothing, never re-ran, and
 * left the pane size at zero. Fit zoom fell back to 1, and the toolbar read
 * "Fit" while the image sat at 100% and overflowed the frame.
 *
 * Asserting on the rendered geometry is the only thing that catches that, so
 * these tests measure real boxes in a real browser.
 */

// A 1200x1800 portrait image, the rough shape of a stacked frame and far
// larger than the viewer pane, so an unfitted image visibly overflows.
const WIDE = 1200;
const TALL = 1800;

function pngResponse() {
  // Solid-colour PNG scaled by the browser to WIDE x TALL via intrinsic size
  // is not possible, so serve an SVG instead: it has a real intrinsic size and
  // `naturalWidth`/`naturalHeight` report it.
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

  // Both the full image and the thumbnail resolve to the same oversized asset.
  await page.route('**/api/library/file**', r => r.fulfill(pngResponse()));

  await page.goto('/observations/M42/2024-03-15');

  // Open the viewer by clicking the stacked image tile.
  // Not `img[src*="NGC1432"]` alone: the session hero draws a blurred, decorative
  // copy of the same frame behind the whole panel, and it comes first in the DOM,
  // so a bare src match resolves to something that is not clickable.
  const tile = page.locator('img[src*="NGC1432"]:not([aria-hidden="true"])').first();
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Image viewer fit', () => {
  test('the image fits inside its pane on open', async ({ page }) => {
    const dialog = await openViewer(page);

    const img = dialog.locator('img[alt]:not([aria-hidden="true"])').first();
    await expect(img).toBeVisible();

    // Let the load handler and the resulting measurement settle.
    await expect
      .poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5000 })
      .toBeGreaterThan(0);

    const imgBox = await img.boundingBox();
    const paneBox = await dialog.locator('[data-lightbox-pane]').boundingBox();
    expect(imgBox).not.toBeNull();
    expect(paneBox).not.toBeNull();

    // One pixel of tolerance for subpixel rounding.
    expect(imgBox!.width).toBeLessThanOrEqual(paneBox!.width + 1);
    expect(imgBox!.height).toBeLessThanOrEqual(paneBox!.height + 1);
  });

  test('fit never scales an image beyond 100%', async ({ page }) => {
    const dialog = await openViewer(page);
    const img = dialog.locator('img[alt]:not([aria-hidden="true"])').first();
    await expect
      .poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5000 })
      .toBeGreaterThan(0);

    const box = await img.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(WIDE + 1);
    expect(box!.height).toBeLessThanOrEqual(TALL + 1);
  });

  test('the zoom readout reports true scale, not pane fraction', async ({ page }) => {
    const dialog = await openViewer(page);
    const img = dialog.locator('img[alt]:not([aria-hidden="true"])').first();
    await expect
      .poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5000 })
      .toBeGreaterThan(0);

    // 1:1 must render the image at its natural pixel size.
    await dialog.getByRole('button', { name: 'Actual size' }).click();

    await expect
      .poll(async () => Math.round((await img.boundingBox())?.width ?? 0), { timeout: 5000 })
      .toBe(WIDE);
  });
});
