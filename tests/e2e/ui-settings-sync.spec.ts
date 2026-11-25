import { test, expect, type Request } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth } from './fixtures/mocks';

const json = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });

test.describe('UI settings saved on the server', () => {
  test('a signed-in user gets their saved theme and language in a browser with no local settings', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await page.route('**/api/preferences/ui', r => r.fulfill(json({ 'nebulis-theme': 'light', 'nebulis-language': 'de' })));

    await page.goto('/settings');

    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    await expect(page.getByText('Sprache', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('nebulis-theme'))).toBe('light');
  });

  test('a change is sent to the server', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    const patches: unknown[] = [];
    await page.route('**/api/preferences/ui', r => {
      const req: Request = r.request();
      if (req.method() === 'PATCH') {
        const body: unknown = req.postDataJSON();
        patches.push(body);
        return r.fulfill(json(body));
      }
      return r.fulfill(json({}));
    });

    await page.goto('/settings');
    await page.getByRole('combobox', { name: /display language/i }).selectOption('fr');

    await expect.poll(() => patches.some(p => (p as Record<string, string>)['nebulis-language'] === 'fr')).toBe(true);
  });
});
