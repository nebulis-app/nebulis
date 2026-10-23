import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

/**
 * The shared `MOCK.telescopes` fixture carries no `archivedAt` field, so the
 * row renders inside the "Archived" list, which has only Restore/Delete and no
 * Edit, Sync, or auto-import controls. Connection and import settings moved to
 * the per-telescope edit modal, so the tests that exercise them need a
 * complete, non-archived profile. Overridden here rather than in the shared
 * fixture.
 */
const ACTIVE_TELESCOPE = {
  ...MOCK.telescopes[0],
  model: 'SeeStar S50',
  kind: 'seestar-s50',
  shareName: 'Seestar',
  username: 'seestar',
  password: '',
  hasPassword: false,
  connectionType: 'smb',
  autoImportEnabled: true,
  autoImportInterval: 60,
  archivedAt: null,
  activeTransportId: null,
  pinnedTransportId: null,
  sessionCount: 0,
  transports: [],
};

function json(data: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) };
}

/** Serve one live (non-archived) Seestar profile and re-render Settings. */
async function mockActiveTelescope(page: Page) {
  await page.route('**/api/telescopes', r => r.fulfill(json([ACTIVE_TELESCOPE])));
  await page.reload();
}

/**
 * Open the per-telescope editor. It is tabbed (Telescope / Connect / Import)
 * and opens on Telescope, so pass the tab that holds the field under test.
 */
async function openTelescopeEditor(page: Page, tab?: 'Connect' | 'Import') {
  await page.getByRole('button', { name: 'Telescopes' }).click();
  await page.getByRole('button', { name: 'Edit telescope' }).click();
  if (tab) await page.getByRole('tab', { name: tab }).click();
}

/** Settings groups are a sidebar of tabs, not one long page. */
async function openUsersTab(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Users' }).click();
}

/**
 * The document-level save bar is dirty-state driven: neither Save nor Discard
 * renders until a form field differs from the loaded settings. Switch the
 * temperature unit to make the general form dirty.
 */
async function makeSettingsDirty(page: Page) {
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('button', { name: '°C' }).click();
}

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
  });

  // ─── Per-telescope connection ─────────────────────────────────────────────
  // The global SMB form (hostname/share/username) and its "Test connection"
  // button were removed from Settings. Connection details are now configured
  // per telescope in the Add/Edit telescope modal (AddTelescopeModal), reached
  // from Settings → Telescopes.

  test('shows SMB hostname field pre-filled', async ({ page }) => {
    await mockActiveTelescope(page);
    await openTelescopeEditor(page, 'Connect');
    await expect(page.locator('input[value="192.168.1.100"]')).toBeVisible();
  });

  test('shows share name field', async ({ page }) => {
    await mockActiveTelescope(page);
    await openTelescopeEditor(page, 'Connect');
    await expect(page.locator('input[value="Seestar"]')).toBeVisible();
  });

  test('shows username field', async ({ page }) => {
    await mockActiveTelescope(page);
    await openTelescopeEditor(page, 'Connect');
    await expect(page.locator('input[value="seestar"]')).toBeVisible();
  });

  test('test connection button is present', async ({ page }) => {
    await mockActiveTelescope(page);
    await openTelescopeEditor(page, 'Connect');
    await expect(page.getByRole('button', { name: /test connection/i })).toBeVisible();
  });

  test('test connection success shows success message', async ({ page }) => {
    await mockActiveTelescope(page);
    // The endpoint moved from POST /api/telescope/test to
    // POST /api/telescopes/test-connection.
    await page.route('**/api/telescopes/test-connection', r => r.fulfill(json(MOCK.connectionTest)));
    await openTelescopeEditor(page, 'Connect');

    await page.getByRole('button', { name: /test connection/i }).click();
    await expect(page.getByText(/connected|success|found/i)).toBeVisible({ timeout: 5000 });
  });

  test('test connection failure shows error message', async ({ page }) => {
    await mockActiveTelescope(page);
    await page.route('**/api/telescopes/test-connection', r => r.fulfill(json(MOCK.connectionTestFailed)));
    await openTelescopeEditor(page, 'Connect');

    await page.getByRole('button', { name: /test connection/i }).click();
    await expect(page.getByText(/error|failed|refused/i)).toBeVisible({ timeout: 5000 });
  });

  // ─── Save settings ────────────────────────────────────────────────────────

  test('save button is present', async ({ page }) => {
    await makeSettingsDirty(page);
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible();
  });

  test('saving settings calls PUT API with the changed field', async ({ page }) => {
    let putBody: unknown = null;
    await page.route('**/api/settings', async r => {
      if (r.request().method() === 'PUT') putBody = r.request().postDataJSON();
      r.fulfill(json(MOCK.settings));
    });

    await makeSettingsDirty(page); // switches the temperature unit to Celsius
    await page.getByRole('button', { name: /save/i }).click();
    await expect.poll(() => putBody).not.toBeNull();
    expect((putBody as { temperatureUnit?: string }).temperatureUnit).toBe('celsius');
  });

  // ─── Observer location ────────────────────────────────────────────────────
  // Latitude/longitude left the top level of Settings and now belong to an
  // observing site, edited from Settings → Sky → Observing sites.

  test('shows latitude field', async ({ page }) => {
    // `exact` matters: the General tab's "Nebula backdrop" help button has an
    // aria-label containing "deep-sky", which a substring match also hits.
    await page.getByRole('button', { name: 'Sky', exact: true }).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByPlaceholder(/40\.7128/)).toHaveValue('37.77');
  });

  test('shows longitude field', async ({ page }) => {
    // `exact` matters: the General tab's "Nebula backdrop" help button has an
    // aria-label containing "deep-sky", which a substring match also hits.
    await page.getByRole('button', { name: 'Sky', exact: true }).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByPlaceholder(/74\.0060/)).toHaveValue('-122.42');
  });

  // ─── API key management ───────────────────────────────────────────────────
  // Removed. The Settings API-key card (generate/revoke against
  // /api/settings/generate-api-key and /api/settings/api-key) is gone from the
  // app: `apiKey` is still on the Settings type and the client still sends the
  // stored secret, but nothing in src/ renders a control for it any more.
  // Client access is now granted per device by the QR/pairing flow in
  // ConnectedDevicesSection instead of a shared API key, so the three tests
  // that covered that card (section present, generate, revoke) were deleted
  // rather than pointed at a control that no longer exists.

  // ─── User management ──────────────────────────────────────────────────────
  // Users moved from the top level into Settings → Account → Users.

  test('shows user management section', async ({ page }) => {
    await openUsersTab(page);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  });

  test('shows existing users', async ({ page }) => {
    await openUsersTab(page);
    await expect(page.getByText('Test User', { exact: true })).toBeVisible();
    await expect(page.getByText('Admin User', { exact: true })).toBeVisible();
  });

  test('create user button is present', async ({ page }) => {
    await openUsersTab(page);
    await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
  });

  test('create user form appears on click', async ({ page }) => {
    await openUsersTab(page);
    await page.getByRole('button', { name: 'Add user' }).click();

    // The create form's labels are not associated with their inputs, so the
    // fields are located by their placeholders.
    await expect(page.getByPlaceholder('jane', { exact: true })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('creating a user calls POST API with the entered fields', async ({ page }) => {
    let postBody: unknown = null;
    await page.route('**/api/auth/users', async r => {
      if (r.request().method() === 'POST') postBody = r.request().postDataJSON();
      r.fulfill(json(MOCK.users));
    });

    await openUsersTab(page);
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByPlaceholder('Jane Doe').fill('New User');
    await page.getByPlaceholder('jane', { exact: true }).fill('newuser');
    await page.getByPlaceholder('jane@example.com').fill('new@example.com');
    await page.locator('input[type="password"]').fill('password123');
    await page.getByRole('button', { name: 'Create user' }).click();

    await expect.poll(() => postBody).not.toBeNull();
    expect(postBody).toMatchObject({
      username: 'newuser',
      email: 'new@example.com',
    });
  });

  test('delete user button is present', async ({ page }) => {
    await openUsersTab(page);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(MOCK.users.length);
  });

  // ─── Import/Sync settings ─────────────────────────────────────────────────
  // The global sync/import toggles (syncEnabled, syncJpg, autoImport, ...) were
  // removed from Settings. Each telescope now carries its own auto-import
  // switch and file-type filters, on the edit modal's "Import"
  // tab.

  test('import settings section is present', async ({ page }) => {
    await mockActiveTelescope(page);
    await openTelescopeEditor(page, 'Import');

    await expect(page.getByText('Auto-import from this telescope')).toBeVisible();
  });

  test('sync toggle checkboxes are present', async ({ page }) => {
    await mockActiveTelescope(page);
    await page.getByRole('button', { name: 'Telescopes' }).click();

    // The per-telescope auto-import control is a switch, not a checkbox.
    await expect(page.getByRole('switch', { name: /auto-import/i })).toBeVisible();
  });

  // ─── Horizon editor ───────────────────────────────────────────────────────
  // The 36-point horizon profile editor was replaced by the per-site
  // visible-sky mask editor (bands measured up from the horizon), reached from
  // Settings → Sky → Observing sites → "Set visible sky".

  test('horizon editor section is present', async ({ page }) => {
    // `exact` matters: the General tab's "Nebula backdrop" help button has an
    // aria-label containing "deep-sky", which a substring match also hits.
    await page.getByRole('button', { name: 'Sky', exact: true }).click();
    await page.getByRole('button', { name: /set visible sky/i }).click();

    await expect(page.getByRole('heading', { name: 'Set Visible Sky' })).toBeVisible();
    await expect(page.getByText(/from the horizon/i)).toBeVisible();
  });

  // ─── Header ───────────────────────────────────────────────────────────────

  test('the collapsed header keeps the version beside the Release notes button', async ({ page }) => {
    // Expanded, the version is the large figure on the right; collapsed, the slim bar carries it as text beside the button.
    await page.getByRole('button', { name: /collapse/i }).first().click();
    const bar = page.locator('section').filter({ has: page.getByRole('button', { name: /expand/i }) }).first();
    await expect(bar.getByRole('button', { name: 'Release notes' })).toBeVisible();
    await expect(bar.getByText('v1.0.0')).toBeVisible();
    await expect(bar.getByText('v1.0.0')).toHaveAttribute('title', /build 1/i);
    // Expanding again brings the big figure back and takes the small one out of the bar.
    await page.getByRole('button', { name: /expand/i }).first().click();
    await expect(page.getByText('v1.0.0')).toHaveCount(1);
  });

  // ─── Import status ────────────────────────────────────────────────────────

  test('import status section shows last run', async ({ page }) => {
    // The dedicated import-status card is gone; the Settings hero stat row now
    // reports the last import run from GET /api/library/import/status.
    await expect(page.getByText(/last sync/i)).toBeVisible();
  });

  test('manual import trigger button is present', async ({ page }) => {
    await mockActiveTelescope(page);
    await page.getByRole('button', { name: 'Telescopes' }).click();

    // Triggering an import is now per telescope, from its row in Settings →
    // Telescopes.
    await expect(page.getByRole('button', { name: /sync now/i })).toBeVisible();
  });
});
