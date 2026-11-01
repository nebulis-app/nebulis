import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mockAllRoutes, mockAdminAuth, json, ok } from './fixtures/mocks';

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

test.describe('Combined object page: editing a picture', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.route('**/api/library/objects/*/media**', r => r.fulfill(json(ok(media))));
    await page.goto('/object/M42?view=media');
  });

  test('the viewer offers Edit, and it opens the editor for that picture', async ({ page }) => {
    await page.getByRole('button', { name: 'Telescope image, Mar 15, 2024' }).click();
    await page.getByRole('button', { name: 'Edit image' }).click();
    await expect(page.getByText('Edit Image', { exact: true })).toBeVisible();
    await expect(page.getByText('- Stacked_M42.jpg')).toBeVisible();
  });

  /**
   * Saving used to close the viewer along with the editor, dropping the user
   * back on the grid and leaving the picture they had just edited unfindable.
   * The viewer now stays open and the media list is refetched, which is what
   * brings back the same item with its newly mtime-stamped URLs.
   */
  test('saving keeps the viewer open and shows the refreshed picture', async ({ page }) => {
    const grey = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .jpeg().toBuffer();
    await page.route('**/api/library/file?path=**', r =>
      r.fulfill({ status: 200, contentType: 'image/jpeg', body: grey }));
    await page.route('**/api/library/file/thumbnail**', r =>
      r.fulfill({ status: 200, contentType: 'image/jpeg', body: grey }));
    let mediaRequests = 0;
    let latestPreviewUrl = '';
    await page.route('**/api/library/objects/*/media**', r => {
      mediaRequests += 1;
      // The server re-stamps an overwritten file's URLs with its new mtime, so
      // each response is a fresh copy of the same item at a different address.
      const previewUrl = `/api/library/file/thumbnail?w=2048&h=2048&path=M42%2FStacked_M42.jpg&v=${mediaRequests}`;
      const thumbUrl = `/api/library/file/thumbnail?path=M42%2FStacked_M42.jpg&v=${mediaRequests}`;
      latestPreviewUrl = previewUrl;
      r.fulfill(json(ok({
        ...media,
        items: [{
          ...media.items[0],
          thumbUrl,
          previewUrl,
          file: { ...sessionFile, thumbUrl, previewUrl },
        }],
      })));
    });
    await page.route('**/api/library/objects/*/sessions/*/library-files', r =>
      r.fulfill(json(ok({ objectId: 'M42', date: '2024-03-15', filename: 'Stacked_M42.jpg' }))));

    await page.getByRole('button', { name: 'Telescope image, Mar 15, 2024' }).click();
    await page.getByRole('button', { name: 'Edit image' }).click();
    await expect(page.getByText('Edit Image', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('Edit Image', { exact: true })).toBeHidden();
    // Still on the picture: the viewer's own Edit button, not the object page's grid.
    await expect(page.getByRole('button', { name: 'Edit image' })).toBeVisible();
    // The refetched item's new URL is what the viewer is showing, not the snapshot it opened with.
    await expect.poll(() => mediaRequests).toBeGreaterThan(1);
    await expect(page.locator('img[src*="w=2048"]').first()).toHaveAttribute('src', latestPreviewUrl);
  });
});
