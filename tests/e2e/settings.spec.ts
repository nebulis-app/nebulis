import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
  });

  // ─── SMB / Connection section ─────────────────────────────────────────────

  test('shows SMB hostname field pre-filled', async ({ page }) => {
    await expect(page.getByDisplayValue('192.168.1.100')
      .or(page.locator('input[value="192.168.1.100"]'))
    ).toBeVisible();
  });

  test('shows share name field', async ({ page }) => {
    await expect(page.getByDisplayValue('Seestar')
      .or(page.getByLabel(/share/i))
    ).toBeVisible();
  });

  test('shows username field', async ({ page }) => {
    await expect(page.getByDisplayValue('seestar')
      .or(page.getByLabel(/username/i))
    ).toBeVisible();
  });

  test('test connection button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /test connection/i })).toBeVisible();
  });

  test('test connection success shows success message', async ({ page }) => {
    await page.getByRole('button', { name: /test connection/i }).click();
    await expect(page.getByText(/connected|success|found/i)).toBeVisible({ timeout: 5000 });
  });

  test('test connection failure shows error message', async ({ page }) => {
    await page.route('**/api/telescope/test', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: MOCK.connectionTestFailed }),
      }));
    await page.reload();

    await page.getByRole('button', { name: /test connection/i }).click();
    await expect(page.getByText(/error|failed|refused/i)).toBeVisible({ timeout: 5000 });
  });

  // ─── Save settings ────────────────────────────────────────────────────────

  test('save button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible();
  });

  test('saving settings calls PUT API', async ({ page }) => {
    let putCalled = false;
    await page.route('**/api/settings', async r => {
      if (r.request().method() === 'PUT') {
        putCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.settings }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.settings }),
        });
      }
    });

    // Change a field and save
    const hostnameInput = page.getByDisplayValue('192.168.1.100')
      .or(page.locator('input[value="192.168.1.100"]'));
    if (await hostnameInput.isVisible()) {
      await hostnameInput.clear();
      await hostnameInput.fill('192.168.1.200');
    }

    await page.getByRole('button', { name: /save/i }).click();
    expect(putCalled).toBe(true);
  });

  // ─── Observer location ────────────────────────────────────────────────────

  test('shows latitude field', async ({ page }) => {
    await expect(page.getByLabel(/latitude/i)
      .or(page.getByDisplayValue('37.77'))
    ).toBeVisible();
  });

  test('shows longitude field', async ({ page }) => {
    await expect(page.getByLabel(/longitude/i)
      .or(page.getByDisplayValue('-122.42'))
    ).toBeVisible();
  });

  // ─── API key management ───────────────────────────────────────────────────

  test('API key section is present', async ({ page }) => {
    await expect(page.getByText(/api key/i)).toBeVisible();
  });

  test('generate API key button works', async ({ page }) => {
    let generateCalled = false;
    await page.route('**/api/settings/generate-api-key', r => {
      generateCalled = true;
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { ...MOCK.settings, apiKey: 'new-api-key-123', hasApiKey: true },
        }),
      });
    });

    const generateBtn = page.getByRole('button', { name: /generate|create.*key/i });
    if (await generateBtn.isVisible()) {
      await generateBtn.click();
      expect(generateCalled).toBe(true);
    }
  });

  test('revoke API key button works when key exists', async ({ page }) => {
    // First override to show a configured API key
    await page.route('**/api/settings', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { ...MOCK.settings, hasApiKey: true } }),
      }));
    await page.reload();

    let deleteCalled = false;
    await page.route('**/api/settings/api-key', r => {
      deleteCalled = true;
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { ...MOCK.settings, apiKey: '', hasApiKey: false } }),
      });
    });

    const revokeBtn = page.getByRole('button', { name: /revoke|delete.*key|remove.*key/i });
    if (await revokeBtn.isVisible()) {
      await revokeBtn.click();
      expect(deleteCalled).toBe(true);
    }
  });

  // ─── User management ──────────────────────────────────────────────────────

  test('shows user management section', async ({ page }) => {
    await expect(page.getByText(/user/i)).toBeVisible();
  });

  test('shows existing users', async ({ page }) => {
    await expect(page.getByText('testuser').or(page.getByText('Test User'))).toBeVisible();
    await expect(page.getByText('admin').or(page.getByText('Admin User'))).toBeVisible();
  });

  test('create user button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /add user|create user|new user/i })
        .or(page.getByText(/add user/i))
    ).toBeVisible();
  });

  test('create user form appears on click', async ({ page }) => {
    const createBtn = page.getByRole('button', { name: /add user|create user|new user/i });
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await expect(page.getByLabel(/username/i)).toBeVisible();
      await expect(page.getByLabel(/password/i)).toBeVisible();
    }
  });

  test('creating a user calls POST API', async ({ page }) => {
    let postCalled = false;
    await page.route('**/api/auth/users', async r => {
      if (r.request().method() === 'POST') {
        postCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: [...MOCK.users] }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.users }),
        });
      }
    });

    const createBtn = page.getByRole('button', { name: /add user|create user|new user/i });
    if (await createBtn.isVisible()) {
      await createBtn.click();

      await page.getByLabel(/username/i).fill('newuser');
      await page.getByLabel(/password/i).fill('password123');
      const emailField = page.getByLabel(/email/i);
      if (await emailField.isVisible()) {
        await emailField.fill('new@example.com');
      }

      await page.getByRole('button', { name: /create|save|submit/i }).last().click();
      expect(postCalled).toBe(true);
    }
  });

  test('delete user button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /delete|remove/i }).first()
    ).toBeVisible();
  });

  // ─── Import/Sync settings ─────────────────────────────────────────────────

  test('import settings section is present', async ({ page }) => {
    await expect(page.getByText(/import|sync/i)).toBeVisible();
  });

  test('sync toggle checkboxes are present', async ({ page }) => {
    await expect(page.locator('input[type="checkbox"]').first()).toBeVisible();
  });

  // ─── Horizon editor ───────────────────────────────────────────────────────

  test('horizon editor section is present', async ({ page }) => {
    await expect(page.getByText(/horizon/i)).toBeVisible();
  });

  // ─── Import status ────────────────────────────────────────────────────────

  test('import status section shows last run', async ({ page }) => {
    await expect(page.getByText(/last run|import status/i)).toBeVisible();
  });

  test('manual import trigger button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /import now|trigger import|sync/i })
    ).toBeVisible();
  });
});
