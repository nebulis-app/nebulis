import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth } from './fixtures/mocks';

test.describe('Library mosaic: share image', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Mosaic', exact: true }).click();
  });

  test('the share button opens a preview of the wall with save options', async ({ page }) => {
    await page.getByRole('button', { name: 'Share image' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share image' });
    await expect(dialog.getByRole('img', { name: 'Mosaic preview' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'As shown' })).toHaveAttribute('aria-pressed', 'true');

    await dialog.getByRole('button', { name: 'Square' }).click();
    await expect(dialog.getByText('2048 × 2048')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Download saves a PNG named for the library', async ({ page }) => {
    await page.getByRole('button', { name: 'Share image' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('nebulis-library-mosaic.png');
  });
});
