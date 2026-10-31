import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * Opening a FITS frame in the viewer shows the server's preview picture straight away. The real frame is a download of
 * tens of megabytes that is then decoded on the page's main thread, so it is only fetched once zoom or stretch asks for
 * more than a JPEG can give. These count the requests that reach the mocked server.
 */

const W = 540;
const H = 960;
const FRAME = 'M42/Stacked_M42_2024-03-15.fit';
const SECOND = 'M42/Second_M42_2024-03-15.fit';
const PREVIEW = `/api/library/fits-thumbnail?v=v4&size=preview&path=${encodeURIComponent(FRAME)}`;
const THUMB = `/api/library/fits-thumbnail?v=v4&path=${encodeURIComponent(FRAME)}`;

/** A valid 16-bit FITS frame with a soft gradient, enough for the viewer to decode and stretch. */
function fitsFrame(): Buffer {
  const card = (text: string) => text.padEnd(80, ' ');
  const header = [
    card('SIMPLE  =                    T'),
    card('BITPIX  =                   16'),
    card('NAXIS   =                    2'),
    card(`NAXIS1  = ${String(W).padStart(20)}`),
    card(`NAXIS2  = ${String(H).padStart(20)}`),
    card('BZERO   =                32768'),
    card('BSCALE  =                    1'),
    card('END'),
  ].join('');
  const headerBlock = Buffer.alloc(Math.ceil(header.length / 2880) * 2880, 0x20);
  headerBlock.write(header, 0, 'ascii');
  const dataBlock = Buffer.alloc(Math.ceil((W * H * 2) / 2880) * 2880);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      dataBlock.writeInt16BE(((x + y) % 2000) - 1000, (y * W + x) * 2);
    }
  }
  return Buffer.concat([headerBlock, dataBlock]);
}

const FILE = {
  name: 'Stacked_M42_2024-03-15.fit', size: 1_048_576, type: 'fits' as const, fileType: 'stacked' as const,
  path: FRAME, exposure: '10.0s', filter: 'IRCUT', timestamp: '2024-03-15T22:30:00', date: '2024-03-15', frameCount: 120,
  isThumbnail: false, previewable: true,
  downloadUrl: `/api/library/file?path=${encodeURIComponent(FRAME)}`,
  thumbUrl: THUMB,
  previewUrl: PREVIEW,
};

/** A session normally has a picture of the stack too. Without one the page's hero would download the .fit itself. */
const JPG = {
  name: 'Stacked_M42_2024-03-15.jpg', size: 2_097_152, type: 'image' as const, fileType: 'stacked' as const,
  path: 'M42/Stacked_M42_2024-03-15.jpg', exposure: '10.0s', filter: 'IRCUT', timestamp: '2024-03-15T22:30:00',
  date: '2024-03-15', frameCount: 120, isThumbnail: false, previewable: true,
  downloadUrl: '/api/library/file/jpg-stack.jpg',
  thumbUrl: '/api/library/file/thumbnail?path=M42%2FStacked_M42_2024-03-15.jpg',
};

async function openViewer(page: Page, opts: { secondFrame?: boolean; slowSecondHeader?: number } = {}) {
  const counts = { frame: 0, preview: 0, headers: 0 };
  await mockAllRoutes(page);
  const detail = JSON.stringify(ok({
    ...MOCK.observationDetail, files: opts.secondFrame
      ? [JPG, FILE, { ...FILE, name: 'Second_M42_2024-03-15.fit', path: SECOND, timestamp: '2024-03-15T22:40:00',
          downloadUrl: `/api/library/file?path=${encodeURIComponent(SECOND)}`,
          thumbUrl: THUMB.replace(encodeURIComponent(FRAME), encodeURIComponent(SECOND)),
          previewUrl: PREVIEW.replace(encodeURIComponent(FRAME), encodeURIComponent(SECOND)) }]
      : [JPG, FILE],
    stackedCount: 1, fitsCount: opts.secondFrame ? 2 : 1, subFrameCount: 0, processedCount: 0,
  }));
  await page.route('**/api/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: detail }));
  await page.route('**/api/library/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: detail }));
  // The server's previews are squares with the frame centred on black.
  const squareWithFrame = (side: number) => {
    const w = Math.round(side * W / H);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><rect width="100%" height="100%" fill="#000"/><rect x="${(side - w) / 2}" width="${w}" height="${side}" fill="#234"/></svg>`;
  };
  const svg = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#234"/></svg>`;
  await page.route('**/api/library/fits-thumbnail**', r => {
    const isPreview = r.request().url().includes('size=preview');
    if (isPreview) counts.preview++;
    return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: isPreview ? squareWithFrame(1024) : svg(135, 240) });
  });
  const frame = fitsFrame();
  await page.route('**/api/library/file/**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(100, 100) }));
  await page.route(/\/api\/library\/file\?path=/, r => {
    counts.frame++;
    return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: frame });
  });
  await page.route('**/api/library/headers**', async r => {
    counts.headers++;
    if (opts.slowSecondHeader && r.request().url().includes('Second')) await new Promise(res => setTimeout(res, opts.slowSecondHeader));
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(ok({ cards: [], values: { NAXIS1: W, NAXIS2: H }, categorized: {} })),
    });
  });

  await page.goto('/observations/M42/2024-03-15');
  const tile = page.locator('img[src*="fits-thumbnail"]:not([src*="size=preview"])').first();
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return { dialog, counts };
}

test.describe('FITS viewer opens on the preview', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows the preview picture and does not download the frame', async ({ page }) => {
    const { dialog, counts } = await openViewer(page);
    await expect(dialog.locator('img[src*="size=preview"]')).toBeVisible();
    // Give a stray download every chance to start before asserting it did not.
    await page.waitForTimeout(800);
    expect(counts.frame).toBe(0);
    await expect(dialog.locator('canvas')).toHaveCount(0);
  });

  test('crops the square preview to the frame instead of stretching it', async ({ page }) => {
    const { dialog, counts } = await openViewer(page);
    const preview = dialog.locator('img[src*="size=preview"]');
    await expect(preview).toBeVisible();
    await expect.poll(() => counts.headers).toBeGreaterThan(0);
    // The frame is taller than the pane, so fit shrinks it. Its box keeps the frame's shape...
    const frame = preview.locator('..');
    await expect.poll(async () => (await frame.boundingBox())?.height ?? H).toBeLessThan(H);
    const box = (await frame.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(W / H, 1);
    // ...and the picture inside is the square drawn at true proportions, not squeezed into that box.
    const img = (await preview.boundingBox())!;
    expect(img.width).toBeCloseTo(img.height, 0);
    expect(img.height).toBeCloseTo(box.height, 0);
  });

  test('stepping to the next frame never shows the uncropped square, even while its size is still loading', async ({ page }) => {
    const { dialog } = await openViewer(page, { secondFrame: true, slowSecondHeader: 2000 });
    await expect(dialog.locator('img[src*="size=preview"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const next = dialog.locator('img[src*="Second"][src*="size=preview"]');
    await next.waitFor({ state: 'attached' });
    // Its header is still on the way. Whatever is on screen must be laid out as the frame, never the square with its
    // black bars: either cropped to a frame-shaped box (the previous frame's size, same sensor) or not shown.
    await page.waitForTimeout(300);
    const state = await next.evaluate((img) => ({
      hidden: getComputedStyle(img).visibility === 'hidden',
      cropped: !!img.parentElement && getComputedStyle(img.parentElement).overflow === 'hidden',
    }));
    expect(state.hidden || state.cropped).toBe(true);
  });

  test('zooming in fetches the real frame, then swaps the preview for it', async ({ page }) => {
    const { dialog, counts } = await openViewer(page);
    await expect(dialog.locator('img[src*="size=preview"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    await expect(dialog.locator('canvas')).toBeVisible();
    expect(counts.frame).toBe(1);
    await expect(dialog.locator('img[src*="size=preview"]')).toHaveCount(0);
  });

  test('moving the stretch fetches the real frame too', async ({ page }) => {
    const { dialog, counts } = await openViewer(page);
    await expect(dialog.locator('img[src*="size=preview"]')).toBeVisible();
    await dialog.getByRole('slider', { name: 'Stretch' }).fill('0.8');
    await expect(dialog.locator('canvas')).toBeVisible();
    expect(counts.frame).toBe(1);
  });
});
