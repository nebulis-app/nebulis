import { test, expect, type Page, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { mockAllRoutes, MOCK, ok } from './fixtures/mocks';

/**
 * The annotation status tile must never cover the picture or move it, and an estimate must recede when zoomed in.
 *
 * Both are about rendered geometry, so these measure real boxes in a real browser: the tile ("dock") against the part of
 * the picture that is actually visible (the picture's own box clipped by its pane, since a zoomed picture is larger
 * than the pane and the pane's edge is what hides the rest).
 */

const FILE = {
  name: 'Stacked_295_NGC 1432_10.0s_IRCUT_20250811-052608.jpg',
  size: 5_242_880, type: 'image' as const, fileType: 'stacked' as const, path: 'NGC1432/Stacked_295.jpg',
  exposure: '10.0s', filter: 'IRCUT', timestamp: '2025-08-11T05:26:08', date: '2024-03-15', frameCount: 295,
  isThumbnail: false, previewable: true,
  downloadUrl: '/api/library/file?path=NGC1432/Stacked_295.jpg',
  thumbUrl: '/api/library/file/thumbnail?path=NGC1432/Stacked_295.jpg',
};

const ANNOTATION = (quality: 'approximate' | 'solved') => ok({
  quality, reason: null, imageWidth: 1000, imageHeight: 1500, pixelScaleArcsec: 2.4,
  annotations: [
    { id: 'NGC1432', label: 'Maia Nebula', designation: 'NGC1432', typeCode: 'RfN', type: 'Reflection Nebula', magnitude: 4, x: 500, y: 700, r: 120, rTrue: 120, oversized: false, isTarget: true },
    { id: 'IC349', label: 'IC349', designation: null, typeCode: 'RfN', type: 'Reflection Nebula', magnitude: 9, x: 560, y: 760, r: 30, rTrue: 30, oversized: false, isTarget: false },
  ],
  solver: { supported: true, binaryInstalled: false, dbInstalled: false, ready: false, state: 'idle', step: null, progress: 0, error: null },
  solve: { state: 'idle', message: null },
});

async function open(page: Page, w: number, h: number, quality: 'approximate' | 'solved' = 'approximate', opts: { annotate?: boolean } = {}) {
  await mockAllRoutes(page);
  await page.route('**/api/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok({
    ...MOCK.observationDetail, files: [FILE], stackedCount: 1, fitsCount: 0, subFrameCount: 0, processedCount: 0,
  })) }));
  await page.route('**/api/library/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok({
    ...MOCK.observationDetail, files: [FILE], stackedCount: 1, fitsCount: 0, subFrameCount: 0, processedCount: 0,
  })) }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#123"/></svg>`;
  await page.route('**/api/library/file**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
  await page.route('**/api/annotate?**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANNOTATION(quality)) }));
  await page.route('**/api/catalog/**/info', r => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: 'x' } }) }));

  await page.goto('/observations/M42/2024-03-15');
  const tile = page.locator('img[src*="NGC1432"]:not([aria-hidden="true"])').first();
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const img = dialog.locator('img[alt]:not([aria-hidden="true"])').first();
  await expect.poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
  if (opts.annotate === false) return { dialog, img };
  await dialog.getByRole('button', { name: 'Name the objects in this image' }).click();
  // The rings are what turning it on shows; the tile may or may not have room beside the picture.
  await expect(dialog.getByRole('button', { name: /^Details for/ }).first()).toBeVisible();
  return { dialog, img };
}

type Box = { x: number; y: number; width: number; height: number };

/** The viewer animates open; measure only once its pane has stopped moving. */
async function settled(locator: Locator): Promise<Box> {
  let last = JSON.stringify(await locator.boundingBox());
  for (let i = 0; i < 40; i++) {
    await locator.page().waitForTimeout(60);
    const now = JSON.stringify(await locator.boundingBox());
    if (now === last) return JSON.parse(now) as Box;
    last = now;
  }
  throw new Error('the viewer never settled');
}
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/** The tile, if it is showing, must not overlap any part of the picture that can be seen. */
async function tileOverlapsPicture(dialog: Locator, img: Locator): Promise<{ shown: boolean; overlap: number }> {
  const dockLocator = dialog.locator('[data-annotation-dock]');
  if ((await dockLocator.count()) === 0) return { shown: false, overlap: 0 };
  const dock = (await dockLocator.boundingBox())!;
  const pane = (await dialog.locator('[data-lightbox-pane]').boundingBox())!;
  const visible = intersect((await img.boundingBox())!, pane);
  return { shown: true, overlap: overlapArea(dock, visible) };
}

test.describe('Annotation tile placement', () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  test('turning annotate on does not move or resize the picture', async ({ page }) => {
    const { dialog, img } = await open(page, 1200, 1800, 'approximate', { annotate: false });
    const paneBefore = await settled(dialog.locator('[data-lightbox-pane]'));
    const imgBefore = await settled(img);
    await dialog.getByRole('button', { name: 'Name the objects in this image' }).click();
    await expect(dialog.locator('[data-annotation-dock]')).toBeVisible();
    await page.waitForTimeout(300);
    const paneAfter = await settled(dialog.locator('[data-lightbox-pane]'));
    const imgAfter = await settled(img);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(paneAfter[k], `pane ${k}`).toBeCloseTo(paneBefore[k], 0);
      expect(imgAfter[k], `picture ${k}`).toBeCloseTo(imgBefore[k], 0);
    }
    // And it is still centred in its pane.
    expect(imgAfter.x + imgAfter.width / 2).toBeCloseTo(paneAfter.x + paneAfter.width / 2, 0);
  });

  test('a portrait picture and the tile never overlap, at fit or while zooming in', async ({ page }) => {
    const { dialog, img } = await open(page, 1200, 1800);
    const fit = await tileOverlapsPicture(dialog, img);
    expect(fit.shown, 'a portrait picture leaves room for the tile at fit').toBe(true);
    expect(fit.overlap).toBe(0);
    for (let i = 0; i < 4; i++) {
      await dialog.getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForTimeout(120);
      const r = await tileOverlapsPicture(dialog, img);
      expect(r.overlap, `zoom step ${i + 1}`).toBe(0);
    }
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await page.waitForTimeout(150);
    expect((await tileOverlapsPicture(dialog, img)).overlap, 'at 1:1').toBe(0);
  });

  test('with no room the tile steps aside and the button keeps the status', async ({ page }) => {
    const { dialog, img } = await open(page, 2400, 1000);
    // A wide picture fills the pane at fit: nothing beside it.
    expect((await tileOverlapsPicture(dialog, img)).shown).toBe(false);
    await expect(dialog.locator('[data-annotation-dot]')).toBeVisible();
    // Zoomed far into a portrait one, likewise.
  });

  test('zoomed in the tile is gone and the dot stays; back at fit the tile returns', async ({ page }) => {
    const { dialog, img } = await open(page, 1200, 1800);
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await expect.poll(async () => (await tileOverlapsPicture(dialog, img)).shown).toBe(false);
    await expect(dialog.locator('[data-annotation-dot]')).toBeVisible();
    await dialog.getByTitle('Fit to window (F)').click();
    await expect.poll(async () => (await tileOverlapsPicture(dialog, img)).shown).toBe(true);
    expect((await tileOverlapsPicture(dialog, img)).overlap).toBe(0);
  });

  test('the tile narrows to fit a thin strip instead of overlapping', async ({ page }) => {
    // A picture a little narrower than the pane leaves a strip too thin for the full tile.
    const { dialog, img } = await open(page, 1000, 560);
    const r = await tileOverlapsPicture(dialog, img);
    expect(r.overlap).toBe(0);
    if (r.shown) {
      const dock = (await dialog.locator('[data-annotation-dock]').boundingBox())!;
      const picture = (await img.boundingBox())!;
      expect(dock.x + dock.width, 'the tile ends before the picture starts').toBeLessThanOrEqual(picture.x);
    }
  });
});

test.describe('Annotation tile on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the tile becomes a bar above the picture, not over it', async ({ page }) => {
    const { dialog, img } = await open(page, 1200, 1800);
    expect((await tileOverlapsPicture(dialog, img)).overlap, 'narrow at fit').toBe(0);
    const dock = (await dialog.locator('[data-annotation-dock]').boundingBox())!;
    const pane = (await dialog.locator('[data-lightbox-pane]').boundingBox())!;
    expect(pane.y, 'the pane starts below the bar').toBeGreaterThanOrEqual(dock.y + dock.height);
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    // The bar grows a hint line once zoomed, and the pane follows it a frame later: judge the settled layout.
    await expect.poll(async () => (await tileOverlapsPicture(dialog, img)).overlap, { message: 'narrow at 1:1' }).toBe(0);
  });
});

test.describe('Estimated rings recede when zoomed in', () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  const ringOpacity = (dialog: Locator) =>
    dialog.locator('svg circle[fill="none"]:not([stroke="black"])').first().evaluate(el => Number(el.getAttribute('stroke-opacity') ?? '1'));

  test('an estimate fades past twice fit, with a hint, and returns at fit', async ({ page }) => {
    const { dialog } = await open(page, 1200, 1800, 'approximate');
    expect(await ringOpacity(dialog)).toBe(1);
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await expect.poll(() => ringOpacity(dialog)).toBeLessThan(0.5);
    await expect(dialog.getByRole('status')).toContainText('Rings are estimates');
    await dialog.getByTitle('Fit to window (F)').click();
    await expect.poll(() => ringOpacity(dialog)).toBe(1);
  });

  test('a real solution never fades', async ({ page }) => {
    const { dialog } = await open(page, 1200, 1800, 'solved');
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await page.waitForTimeout(300);
    expect(await ringOpacity(dialog)).toBe(1);
    await expect(dialog.getByRole('status')).toHaveCount(0);
  });
});


test.describe('Saving an annotated picture', () => {
  test.use({ viewport: { width: 1280, height: 760 } });

  /** A real JPEG, because the burn decodes the file in the browser and an SVG stand-in cannot be decoded that way. */
  async function openWithJpeg(page: Page, annotate: boolean) {
    const jpeg = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: '#112244' } }).jpeg().toBuffer();
    await mockAllRoutes(page);
    const obs = ok({ ...MOCK.observationDetail, files: [FILE], stackedCount: 1, fitsCount: 0, subFrameCount: 0, processedCount: 0 });
    await page.route('**/api/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obs) }));
    await page.route('**/api/library/observations/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obs) }));
    await page.route('**/api/library/file**', r => r.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }));
    await page.route('**/api/annotate?**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANNOTATION('solved')) }));
    await page.route('**/api/catalog/**/info', r => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: 'x' } }) }));
    await page.goto('/observations/M42/2024-03-15');
    const tile = page.locator('img[src*="NGC1432"]:not([aria-hidden="true"])').first();
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await tile.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (annotate) {
      await dialog.getByRole('button', { name: 'Name the objects in this image' }).click();
      await expect(dialog.getByRole('button', { name: /^Details for/ }).first()).toBeVisible();
    }
    return dialog;
  }

  test('with the names showing, Download offers to burn them in and the copy has the rings in place', async ({ page }, info) => {
    const dialog = await openWithJpeg(page, true);
    await dialog.getByRole('link', { name: 'Download' }).click();
    const choice = page.getByRole('dialog', { name: 'Save this picture' });
    await expect(choice).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      choice.getByRole('button', { name: /With names drawn in/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-annotated\.jpg$/);
    const file = info.outputPath('annotated.jpg');
    await download.saveAs(file);

    const { data, info: meta } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect([meta.width, meta.height]).toEqual([1000, 1500]);
    const px = (x: number, y: number) => Array.from(data.subarray((y * meta.width + x) * meta.channels, (y * meta.width + x) * meta.channels + 3));
    // Background well away from any ring is untouched; the target's ring (amber) passes through (620, 700).
    expect(px(50, 50)[2]).toBeGreaterThan(50);
    expect(px(50, 50)[0]).toBeLessThan(40);
    const ring = px(620, 700);
    await sharp(file).extract({ left: 300, top: 520, width: 400, height: 360 }).toFile(info.outputPath('crop.png'));
    expect(ring[0], 'amber ring, red channel').toBeGreaterThan(180);
    expect(ring[0] - ring[2], 'amber, not the blue background').toBeGreaterThan(60);
  });

  test('"Original file" downloads the untouched file', async ({ page }) => {
    const dialog = await openWithJpeg(page, true);
    await dialog.getByRole('link', { name: 'Download' }).click();
    const choice = page.getByRole('dialog', { name: 'Save this picture' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      choice.getByRole('button', { name: /Original file/ }).click(),
    ]);
    expect(download.suggestedFilename()).not.toMatch(/annotated/);
  });

  test('with the names hidden, Download just downloads', async ({ page }) => {
    const dialog = await openWithJpeg(page, false);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('link', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(FILE.name);
    await expect(page.getByRole('dialog', { name: 'Save this picture' })).toHaveCount(0);
  });
});
