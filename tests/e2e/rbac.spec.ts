/**
 * Role-Based Access Control — E2E tests
 *
 * Verifies that the viewer role sees a read-only UI and admin sees full controls.
 *
 * Auth setup:
 *   - No token in localStorage → AuthContext short-circuits to 'admin' (open access)
 *   - mockViewerAuth() sets a fake token + mocks /api/auth/me to return role:'viewer'
 *   - mockAdminAuth() sets a fake token + mocks /api/auth/me to return role:'admin'
 *
 * Route registration order matters: `mockAllRoutes()` also registers
 * `**\/api/auth/me` (it answers with the admin fixture), and Playwright runs the
 * most recently registered matching handler first. So every role override below
 * is registered AFTER `mockAllRoutes()` — otherwise the explicit role never
 * takes effect and the viewer cases silently run as admin.
 *
 * All API calls are mocked via page.route() — no live server required.
 */
import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockViewerAuth, mockAdminAuth } from './fixtures/mocks';

// ─── Viewer: Gallery ──────────────────────────────────────────────────────────

test.describe('Viewer — Gallery page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page); // after mockAllRoutes: overrides its /api/auth/me
    await page.goto('/');
  });

  test('shows the library heading', async ({ page }) => {
    // The hero h1 reads "Library" (libraryHero.title in LibraryHero.tsx); the
    // old "Night Sky Library" copy is gone.
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  });

  // Removed: "hides the 'From Telescope' import button". That button no longer
  // exists; syncing moved to the telescope sync pill dropdown in the top nav
  // (src/components/Layout.tsx), and the tests below cover its admin gating.

  test('hides the "Add" menu (Upload Files / New Observation)', async ({ page }) => {
    // Gallery.tsx renders the Add menu, which holds both import controls,
    // behind `isAdmin`.
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /upload files|new observation/i })).toHaveCount(0);
  });

  test('hides the sync triggers in the telescope pill', async ({ page }) => {
    // Syncing writes to the library server-side (POST /api/library/import is
    // requireAdmin), so the triggers are admin-only. The pill itself stays
    // visible so a viewer can still see which scopes are online.
    await page.getByRole('button', { name: /\d+\/\d+ online/i }).click();
    await expect(page.getByRole('button', { name: /^sync all$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^sync seestar s50$/i })).toHaveCount(0);
  });

  test('still shows object cards (read access)', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
    await expect(page.getByText('Andromeda Galaxy')).toBeVisible();
  });

  test('still shows search and filter controls', async ({ page }) => {
    await expect(page.getByPlaceholder(/search/i)).toBeVisible();
  });
});

// ─── Admin: Gallery ───────────────────────────────────────────────────────────

test.describe('Admin — Gallery page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('shows the admin-only library controls', async ({ page }) => {
    // Replaces the removed "From Telescope" import button. Syncing itself now
    // lives in the top-nav telescope pill; the Add menu (Upload Files, New
    // Observation) is the library page's admin-only control (Gallery.tsx).
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /upload files/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /new observation/i })).toBeVisible();
  });

  test('shows "Upload Files" and "New Observation" in the Add menu', async ({ page }) => {
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /upload files/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /new observation/i })).toBeVisible();
  });
});

// ─── Viewer: Settings ─────────────────────────────────────────────────────────

test.describe('Viewer — Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page); // after mockAllRoutes: overrides its /api/auth/me
    await page.goto('/settings');
  });

  test('shows the view-only mode banner', async ({ page }) => {
    // Settings.tsx renders t('page.viewOnlyBanner') when isViewer:
    // "View-only mode. Contact an admin to make changes."
    await expect(page.getByText(/view-only mode/i)).toBeVisible();
  });

  test('does not show the Users section in sidebar', async ({ page }) => {
    // Users is an admin-only section (SETTINGS_NAV account group), so its
    // sidebar entry must be absent for viewers.
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /^users$/i })).toHaveCount(0);
  });

  test('does not show the Danger section in sidebar', async ({ page }) => {
    // The admin-only danger group is labelled "Advanced" now (nav.danger).
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /^advanced$/i })).toHaveCount(0);
  });

  test('save bar is not shown (no dirty state for viewers)', async ({ page }) => {
    // Viewers cannot dirty the form (isDirty is gated on isAdmin), so the
    // floating save bar has no Save button to render.
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /save changes/i })).toHaveCount(0);
  });
});

// ─── Admin: Settings ──────────────────────────────────────────────────────────

test.describe('Admin — Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('does not show the view-only mode banner', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByText(/view-only mode/i)).toHaveCount(0);
  });

  test('shows Users section accessible in sidebar', async ({ page }) => {
    // Users lives inside the Account group, which opens on click.
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(page.getByRole('button', { name: /^users$/i })).toBeVisible();
  });

  test('shows user list in Users section', async ({ page }) => {
    // The sidebar button auto-waits for the settings query to resolve, unlike
    // the old `if (await isVisible())` check, which raced the initial load and
    // skipped the click. Users lives inside the Account group, which opens on click.
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: /^users$/i }).click();
    await expect(page.getByText('Test User')).toBeVisible();
  });
});

// ─── Viewer: Object Detail ────────────────────────────────────────────────────

test.describe('Viewer — Object Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page); // after mockAllRoutes: overrides its /api/auth/me
    await page.goto('/object/M42');
  });

  test('shows object name (read access)', async ({ page }) => {
    // exact: true so "About Orion Nebula" (the panel heading) does not collide.
    await expect(page.getByRole('heading', { name: 'Orion Nebula', level: 1, exact: true })).toBeVisible();
  });

  test('hides the delete object action', async ({ page }) => {
    // Delete lives behind the hero's "More actions" overflow menu, which is
    // rendered for everyone; only the admin-only item is gated (ObjectHero.tsx).
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /delete object/i })).toHaveCount(0);
  });

  test('hides the "Add observation" button', async ({ page }) => {
    // Was a link; it is now an admin-only button (ObjectHero onAddObservation).
    await expect(page.getByRole('button', { name: /add observation/i })).toHaveCount(0);
  });
});

// ─── Admin: Object Detail ─────────────────────────────────────────────────────

test.describe('Admin — Object Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('shows object name', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Orion Nebula', level: 1, exact: true })).toBeVisible();
  });

  test('shows the delete object action', async ({ page }) => {
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /delete object/i })).toBeVisible();
  });
});

// ─── Viewer: Observation Detail ───────────────────────────────────────────────

test.describe('Viewer — Observation Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page); // after mockAllRoutes: overrides its /api/auth/me
    await page.goto('/observations/M42/2024-03-15');
  });

  test('shows the observation (read access)', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'M42 (Orion Nebula)', level: 1, exact: true }),
    ).toBeVisible();
  });

  test('hides the Move observation button', async ({ page }) => {
    // The move/relocate action is a hero overflow-menu item ("Move to another
    // object"). The menu is opened first and confirmed to have rendered, so
    // this cannot pass vacuously on a menu that simply is not there: a viewer
    // still gets "Show file location", just not the admin-only items.
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /show file location/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /move to another object/i })).toHaveCount(0);
  });

  test('hides the Delete observation button', async ({ page }) => {
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /show file location/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /delete session/i })).toHaveCount(0);
  });
});

// ─── Admin: Observation Detail ────────────────────────────────────────────────

test.describe('Admin — Observation Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations/M42/2024-03-15');
  });

  test('shows the Move (Combine) button', async ({ page }) => {
    // Admin-only, and a hero overflow-menu item rather than a top-level button.
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /move to another object/i })).toBeVisible();
  });

  test('shows Delete button', async ({ page }) => {
    await page.getByRole('button', { name: /more actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /delete session/i })).toBeVisible();
  });
});

// ─── Explicit admin via /api/auth/me ─────────────────────────────────────────

test.describe('Admin via explicit /api/auth/me (token present)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page); // after mockAllRoutes: overrides its /api/auth/me
    await page.goto('/');
  });

  test('gallery shows admin-only library controls for explicit admin user', async ({ page }) => {
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /upload files/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /new observation/i })).toBeVisible();
  });

  test('does not show view-only banner on gallery', async ({ page }) => {
    // Wait for an admin-only control first so this is not a vacuous pass
    // during the pre-auth loading window.
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(page.getByText(/view-only mode/i)).toHaveCount(0);
  });
});
