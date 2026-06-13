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
 * All API calls are mocked via page.route() — no live server required.
 */
import { test, expect } from '@playwright/test';
import { mockAllRoutes, mockViewerAuth, mockAdminAuth } from './fixtures/mocks';

// ─── Viewer: Gallery ──────────────────────────────────────────────────────────

test.describe('Viewer — Gallery page', () => {
  test.beforeEach(async ({ page }) => {
    await mockViewerAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('shows the library heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /night sky library/i })).toBeVisible();
  });

  test('hides the "From Telescope" import button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /from telescope/i })).not.toBeVisible();
  });

  test('hides the "Upload Files" button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /upload files/i })).not.toBeVisible();
  });

  test('hides the "New Observation" link', async ({ page }) => {
    await expect(page.getByRole('link', { name: /new observation/i })).not.toBeVisible();
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

  test('shows the "From Telescope" import button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /from telescope/i })).toBeVisible();
  });

  test('shows the "Upload Files" button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /upload files/i })).toBeVisible();
  });

  test('shows the "New Observation" link', async ({ page }) => {
    await expect(page.getByRole('link', { name: /new observation/i })).toBeVisible();
  });
});

// ─── Viewer: Settings ─────────────────────────────────────────────────────────

test.describe('Viewer — Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await mockViewerAuth(page);
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('shows the view-only mode banner', async ({ page }) => {
    await expect(page.getByText(/view.only mode/i)).toBeVisible();
  });

  test('does not show the Users section in sidebar', async ({ page }) => {
    // Users is an admin-only section — its sidebar entry must be absent for viewers
    const sidebar = page.locator('nav, aside').first();
    await expect(sidebar.getByText(/^users$/i)).not.toBeVisible();
  });

  test('does not show the Danger section in sidebar', async ({ page }) => {
    const sidebar = page.locator('nav, aside').first();
    await expect(sidebar.getByText(/danger/i)).not.toBeVisible();
  });

  test('save bar is not shown (no dirty state for viewers)', async ({ page }) => {
    // Viewers cannot dirty the form, so the floating save bar must not appear
    await expect(page.getByRole('button', { name: /save changes/i })).not.toBeVisible();
  });
});

// ─── Admin: Settings ──────────────────────────────────────────────────────────

test.describe('Admin — Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('does not show the view-only mode banner', async ({ page }) => {
    await expect(page.getByText(/view.only mode/i)).not.toBeVisible();
  });

  test('shows Users section accessible in sidebar', async ({ page }) => {
    await expect(page.getByRole('button', { name: /users/i }).or(page.getByText('Users'))).toBeVisible();
  });

  test('shows user list in Users section', async ({ page }) => {
    // Navigate to the Users section if needed
    const usersNav = page.getByRole('button', { name: /^users$/i });
    if (await usersNav.isVisible()) {
      await usersNav.click();
    }
    await expect(page.getByText('Test User').or(page.getByText('testuser'))).toBeVisible();
  });
});

// ─── Viewer: Wishlist (embedded in Planner) ───────────────────────────────────

test.describe('Viewer — Wishlist', () => {
  test.beforeEach(async ({ page }) => {
    await mockViewerAuth(page);
    await mockAllRoutes(page);
    await page.goto('/planner?tab=wishlist');
  });

  test('shows wishlist items (read access)', async ({ page }) => {
    await expect(page.getByText('Whirlpool Galaxy')).toBeVisible();
  });

  test('hides the "Add to wishlist" search panel', async ({ page }) => {
    await expect(page.getByText(/add to wishlist/i)).not.toBeVisible();
  });

  test('hides edit (notes) buttons on wishlist items', async ({ page }) => {
    // Edit pencil buttons should not be rendered for viewers
    const editButtons = page.getByRole('button', { name: /edit/i });
    await expect(editButtons).not.toBeVisible();
  });

  test('hides remove (bookmark-x) buttons on wishlist items', async ({ page }) => {
    // The BookmarkX remove button should not appear for viewers
    // It's a button without a text label, so check for aria-label or use count
    const removeButtons = page.locator('button[title*="remove" i], button[aria-label*="remove" i]');
    await expect(removeButtons).not.toBeVisible();
  });
});

// ─── Admin: Wishlist ──────────────────────────────────────────────────────────

test.describe('Admin — Wishlist', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/planner?tab=wishlist');
  });

  test('shows the "Add to wishlist" search panel', async ({ page }) => {
    await expect(page.getByText(/add to wishlist/i)).toBeVisible();
  });

  test('shows wishlist items', async ({ page }) => {
    await expect(page.getByText('Whirlpool Galaxy')).toBeVisible();
  });
});

// ─── Viewer: Object Detail ────────────────────────────────────────────────────

test.describe('Viewer — Object Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockViewerAuth(page);
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('shows object name (read access)', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });

  test('hides the delete object button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /delete/i })).not.toBeVisible();
  });

  test('hides the "Add Observation" link', async ({ page }) => {
    await expect(page.getByRole('link', { name: /add observation|new observation/i })).not.toBeVisible();
  });
});

// ─── Admin: Object Detail ─────────────────────────────────────────────────────

test.describe('Admin — Object Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/object/M42');
  });

  test('shows object name', async ({ page }) => {
    await expect(page.getByText('Orion Nebula')).toBeVisible();
  });

  test('shows the delete object button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /delete/i })).toBeVisible();
  });
});

// ─── Viewer: Observation Detail ───────────────────────────────────────────────

test.describe('Viewer — Observation Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockViewerAuth(page);
    await mockAllRoutes(page);
    await page.goto('/observations/M42/2024-03-15');
  });

  test('shows the observation (read access)', async ({ page }) => {
    await expect(page.getByText(/orion nebula/i)).toBeVisible();
  });

  test('hides the Move observation button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /move/i })).not.toBeVisible();
  });

  test('hides the Delete observation button', async ({ page }) => {
    // There may be multiple delete buttons; none should be visible for viewers
    await expect(page.getByRole('button', { name: /delete/i }).first()).not.toBeVisible();
  });
});

// ─── Admin: Observation Detail ────────────────────────────────────────────────

test.describe('Admin — Observation Detail page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations/M42/2024-03-15');
  });

  test('shows Move button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /move/i })).toBeVisible();
  });

  test('shows Delete button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /delete/i }).first()).toBeVisible();
  });
});

// ─── Explicit admin via /api/auth/me ─────────────────────────────────────────

test.describe('Admin via explicit /api/auth/me (token present)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await page.goto('/');
  });

  test('gallery shows import buttons for explicit admin user', async ({ page }) => {
    await expect(page.getByRole('button', { name: /from telescope/i })).toBeVisible();
  });

  test('does not show view-only banner on gallery', async ({ page }) => {
    await expect(page.getByText(/view.only mode/i)).not.toBeVisible();
  });
});
