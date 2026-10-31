import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mockAllRoutes, mockAdminAuth, json, ok } from './fixtures/mocks';

/**
 * The Adjust sliders in the image editor apply their change to every pixel of the preview, which is too slow to do on
 * each tick of a drag. The number follows the thumb while dragging and the picture is redrawn once the thumb is let go.
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

/** The red value of the pixel in the middle of the preview canvas. */
async function centreRed(page: Page): Promise<number> {
  return page.locator('[data-image-editor] canvas').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    return ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[0];
  });
}

test.describe('Image editor: adjust sliders', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    const grey = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 100, g: 100, b: 100 } } }).jpeg().toBuffer();
    await page.route('**/api/library/file?path=**', r => r.fulfill({ status: 200, contentType: 'image/jpeg', body: grey }));
    await page.route('**/api/library/objects/*/media**', r => r.fulfill(json(ok(media))));
    await page.goto('/object/M42?view=media');
    await page.getByRole('button', { name: 'Telescope image, Mar 15, 2024' }).click();
    await page.getByRole('button', { name: 'Edit image' }).click();
    await expect(page.getByText('Edit Image', { exact: true })).toBeVisible();
    await expect.poll(() => centreRed(page)).toBeGreaterThan(0);
  });

  test('the picture does not change while the thumb is being dragged, and does once it is let go', async ({ page }) => {
    const before = await centreRed(page);
    const brightness = page.locator('[data-image-editor] input[type="range"]').first();
    const box = (await brightness.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });

    // The number has followed the thumb...
    await expect(page.getByText(/^\+\d+$/).first()).toBeVisible();
    // ...but nothing has been redrawn yet.
    await page.waitForTimeout(250);
    expect(await centreRed(page)).toBe(before);

    await page.mouse.up();
    await expect.poll(() => centreRed(page)).toBeGreaterThan(before + 40);
  });

  test('a click on the track applies straight away', async ({ page }) => {
    const before = await centreRed(page);
    const brightness = page.locator('[data-image-editor] input[type="range"]').first();
    const box = (await brightness.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await expect.poll(() => centreRed(page)).toBeGreaterThan(before + 40);
  });

  test('a key press applies without waiting for a pointer', async ({ page }) => {
    const before = await centreRed(page);
    const brightness = page.locator('[data-image-editor] input[type="range"]').first();
    await brightness.focus();
    await page.keyboard.press('End');
    await expect.poll(() => centreRed(page)).toBeGreaterThan(before + 40);
  });
});
