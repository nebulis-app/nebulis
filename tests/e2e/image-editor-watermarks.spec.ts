import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mockAllRoutes, mockAdminAuth, json, ok } from './fixtures/mocks';

/**
 * Saved watermarks in the image editor's Text panel: saving the block that is
 * on the picture, applying it back at the same spot and relative size, and
 * renaming / updating / deleting it. The PUT body is the observable, because
 * that is the thing the next session will read.
 */

const sessionFile = {
  name: 'Stacked_M42.jpg', size: 1000, type: 'image', fileType: 'stacked', path: 'M42/Stacked_M42.jpg', exposure: null, filter: null,
  timestamp: null, date: '2024-03-15', frameCount: 60, isThumbnail: false, previewable: true, downloadUrl: '/api/library/file?path=M42/Stacked_M42.jpg',
};

const media = {
  counts: { all: 1, processed: 0, telescope: 1, nights: 1, sub: 0, project: 0, video: 0 },
  facets: { telescopes: [], filters: [], nights: [{ date: '2024-03-15', count: 1 }], formats: [] },
  groups: [{ key: '2024-03-15', label: '2024-03-15', date: '2024-03-15', telescope: null, count: 1, subCount: 0, frames: 60, exposure: null, integrationSec: null, pinned: false }],
  items: [{
    id: 'f1', kind: 'telescope', objectId: 'M42', name: 'Stacked_M42.jpg', date: '2024-03-15', telescope: null, exposure: null, filter: null,
    frameCount: 60, format: 'JPG', size: 1000, capturedAt: null, isFavorite: false, previewable: true, path: 'M42/Stacked_M42.jpg',
    thumbUrl: null, previewUrl: null, downloadUrl: sessionFile.downloadUrl, isImage: true, isFits: false, groupKey: '2024-03-15', file: sessionFile,
  }],
  total: 1, nextOffset: null,
};

interface Preset {
  id: string; name: string; text: string; fontSize: number; fontFamily: string; color: string;
  bold: boolean; italic: boolean; opacity: number; align: 'left' | 'center' | 'right'; angle: number;
  sizePct?: number; x?: number; y?: number;
}

const preset = (over: Partial<Preset> = {}): Preset => ({
  id: 'p1', name: 'Corner mark', text: '© Corner', fontSize: 36, fontFamily: 'Arial, sans-serif',
  color: '#ffffff', bold: false, italic: false, opacity: 70, align: 'left', angle: 0, ...over,
});

/** The largest red channel in a region of the preview, as fractions of the canvas. Grey picture = 100, white text = 255. */
async function maxRedNear(page: Page, x: number, y: number): Promise<number> {
  return page.locator('[data-image-editor] canvas').evaluate((el, at) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const rx = Math.max(0, Math.floor((at.x - 0.15) * canvas.width));
    const ry = Math.max(0, Math.floor((at.y - 0.10) * canvas.height));
    const rw = Math.min(canvas.width - rx, Math.floor(0.3 * canvas.width));
    const rh = Math.min(canvas.height - ry, Math.floor(0.11 * canvas.height));
    const { data } = ctx.getImageData(rx, ry, rw, rh);
    let max = 0;
    for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i]);
    return max;
  }, { x, y });
}

test.describe('Image editor: saved watermarks', () => {
  let saved: Preset[] = [];

  test.beforeEach(async ({ page }) => {
    saved = [];
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    const grey = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .jpeg().toBuffer();
    await page.route('**/api/library/file?path=**', r =>
      r.fulfill({ status: 200, contentType: 'image/jpeg', body: grey }));
    await page.route('**/api/library/objects/*/media**', r => r.fulfill(json(ok(media))));
    await page.route('**/api/library/objects/*/sessions/*/library-files', r =>
      r.fulfill(json(ok({ objectId: 'M42', date: '2024-03-15', filename: 'Stacked_M42.jpg' }))));
    await page.route('**/preferences/watermarks', r => {
      if (r.request().method() === 'PUT') {
        saved = r.request().postDataJSON() as Preset[];
        return r.fulfill(json(ok(saved)));
      }
      return r.fulfill(json(ok(saved)));
    });
    await page.goto('/object/M42?view=media');
  });

  /** Open the picture in the editor and switch to the Text tool, where the watermarks live. */
  async function openTextTool(page: Page) {
    await page.getByRole('button', { name: 'Telescope image, Mar 15, 2024' }).click();
    await page.getByRole('button', { name: 'Edit image' }).click();
    await expect(page.getByText('Edit Image', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(page.locator('[data-image-editor] canvas')).toBeVisible();
  }

  test('saves the selected block with its position and its size as a fraction of the picture', async ({ page }) => {
    await openTextTool(page);
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.locator('[data-image-editor] textarea').fill('© Corner');
    const canvasHeight = await page.locator('[data-image-editor] canvas')
      .evaluate(el => (el as HTMLCanvasElement).height);

    await page.locator('[data-watermark-save-toggle]').click();
    await page.getByPlaceholder('Watermark name…').fill('Corner mark');
    await page.locator('[data-watermark-save-submit]').click();

    await expect.poll(() => saved.length).toBe(1);
    const mark = saved[0]!;
    expect(mark.name).toBe('Corner mark');
    expect(mark.text).toBe('© Corner');
    // Add text puts the block at the middle of the picture. The old fixed
    // spot was 0.5/0.9, so this also proves the layer's own position is saved.
    expect(mark.x).toBeCloseTo(0.5, 2);
    expect(mark.y).toBeCloseTo(0.5, 2);
    expect(mark.sizePct).toBeCloseTo(36 / canvasHeight, 3);
    // The legacy pixel size is written too, so a rollback still has something usable.
    expect(mark.fontSize).toBe(36);
  });

  test('applies a saved watermark where it was saved, and re-applying replaces it instead of stacking', async ({ page }) => {
    saved = [preset({ x: 0.3, y: 0.6, sizePct: 0.06 })];
    await openTextTool(page);

    await page.getByRole('button', { name: 'Corner mark', exact: true }).click();
    await expect(page.locator('[data-text-layer]')).toHaveCount(1);
    // White text near the saved anchor; the old fixed spot stays grey.
    await expect.poll(() => maxRedNear(page, 0.3, 0.6)).toBeGreaterThan(200);
    expect(await maxRedNear(page, 0.5, 0.9)).toBeLessThan(200);

    await page.getByRole('button', { name: 'Corner mark', exact: true }).click();
    await expect(page.locator('[data-text-layer]')).toHaveCount(1);
  });

  test('renames, updates from the selected block, and deletes a saved watermark', async ({ page }) => {
    saved = [preset()];
    await openTextTool(page);

    await page.getByRole('button', { name: 'Rename: Corner mark' }).click();
    await page.getByRole('textbox', { name: 'Rename' }).fill('Top left');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect.poll(() => saved[0]?.name).toBe('Top left');
    const id = saved[0]!.id;

    await page.getByRole('button', { name: 'Top left', exact: true }).click();
    await page.locator('[data-image-editor] textarea').fill('© Updated');
    await page.getByRole('button', { name: 'Update "Top left"' }).click();
    await expect.poll(() => saved[0]?.text).toBe('© Updated');
    expect(saved[0]!.name).toBe('Top left');
    expect(saved[0]!.id).toBe(id);

    await page.getByRole('button', { name: 'Delete: Top left' }).click();
    await page.locator('[data-watermark-delete-confirm]').click();
    await expect.poll(() => saved.length).toBe(0);
  });

  test('asks before replacing a watermark with the same name', async ({ page }) => {
    saved = [preset({ id: 'keep', name: 'Corner mark', text: '© Corner' })];
    await openTextTool(page);
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.locator('[data-image-editor] textarea').fill('© Replaced');

    await page.locator('[data-watermark-save-toggle]').click();
    await page.getByPlaceholder('Watermark name…').fill('Corner mark');
    await page.locator('[data-watermark-save-submit]').click();

    // The first click only asks; nothing is written yet.
    await expect(page.getByText('"Corner mark" already exists.')).toBeVisible();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.text).toBe('© Corner');

    await page.locator('[data-watermark-save-submit]').click();
    await expect.poll(() => saved[0]?.text).toBe('© Replaced');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe('keep');
  });

  test('applies a watermark saved before the geometry fields at its old spot', async ({ page }) => {
    saved = [preset({ name: 'Old mark', text: '© Old', fontSize: 36 })];
    await openTextTool(page);

    await page.getByRole('button', { name: 'Old mark', exact: true }).click();
    await expect(page.locator('[data-text-layer]')).toHaveCount(1);
    await expect.poll(() => maxRedNear(page, 0.5, 0.9)).toBeGreaterThan(200);
  });
});
