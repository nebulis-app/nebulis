import { test, expect } from '@playwright/test';
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
});
