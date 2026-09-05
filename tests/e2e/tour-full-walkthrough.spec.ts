import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

/**
 * End-to-end regression guard for the guided product tour.
 *
 * This file exists because of real production bugs, all in the same family:
 * a tour step's `anchorKey` can fail to resolve to a real DOM element for
 * reasons that have nothing to do with a genuine code bug —
 *  - the "telescopes" step's anchor lived only in the desktop settings
 *    sidebar, `hidden` below Tailwind's `lg` breakpoint (1024px);
 *  - the "sync" step anchors on the top-bar sync pill, which Layout.tsx only
 *    renders once at least one telescope is configured — true for
 *    essentially every FIRST run of the tour on a fresh install, since the
 *    telescopes step (right before it) only explains how to add one, it
 *    doesn't require it;
 *  - the "done" step anchors on the Help nav link, which is a user-toggleable
 *    item (Settings → Navigation Bar) and can be hidden entirely.
 *
 * Before the fix, an unresolved anchor left the user looking at a
 * content-free "Looking for this step, keep going" placeholder while the
 * REAL card (title, body, hint, and its Back/Next/Skip controls) sat
 * invisible on top of the page, silently eating clicks. Now:
 *  - TourOverlay.measure() picks whichever matching anchor is actually
 *    visible (there can be more than one for the same anchorKey — a desktop
 *    and a mobile variant) instead of always the first DOM match;
 *  - once a route transition settles, the real dialog is ALWAYS shown
 *    (centered, no spotlight, but full content and controls) if no anchor
 *    was found — never hidden behind a generic placeholder, and never
 *    `pointer-events: auto` while invisible.
 *
 * These tests walk every real step of the tour under the exact conditions
 * that broke it — narrow viewport, zero telescopes configured, Help hidden
 * from the nav — and assert the live dialog, with its real content, is what
 * the user sees. A future change that hides, renames, or removes any tour
 * anchor under any of these conditions should fail one of these.
 */

async function startTour(page: Page) {
  await page.goto('/help');
  await page.getByRole('button', { name: 'Start the guided tour' }).click();
  await expect(page.getByText('Meet Nebulis')).toBeVisible();
  await page.getByRole('button', { name: 'Start the tour' }).click();
}

/**
 * Clicks through the tour to the end, asserting the real dialog is what's
 * driving each step and is genuinely interactive (not the old invisible,
 * `pointer-events: none` card sitting behind a content-free placeholder).
 */
async function walkToEnd(page: Page, maxSteps = 15) {
  for (let i = 0; i < maxSteps; i++) {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveCSS('pointer-events', 'none');
    // Every step must show its own real title, never a generic placeholder.
    await expect(dialog.locator('h3, h2')).not.toHaveText('');

    const finish = dialog.getByRole('button', { name: 'Finish' });
    if (await finish.isVisible().catch(() => false)) {
      await finish.click();
      return;
    }
    await dialog.getByRole('button', { name: 'Next' }).click();
  }
  throw new Error(`Tour did not reach "Finish" within ${maxSteps} steps`);
}

test.describe('Guided tour: full walkthrough', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('nebulis-tour-seen-v1'));
    await mockAllRoutes(page);
  });

  test('every step resolves at the default desktop viewport', async ({ page }) => {
    await startTour(page);
    await walkToEnd(page);
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  // The settings-sidebar bug only reproduced below the `lg` breakpoint
  // (1024px) — most laptop windows that aren't maximized, and every tablet,
  // land here.
  test('every step resolves at a narrow (sub-1024px) viewport', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await startTour(page);
    await walkToEnd(page);
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  // The shared mock fixture (MOCK.allTelescopeStatusList) always seeds at
  // least one telescope, so the default-viewport test above never actually
  // exercised this — the single most common real-world condition for a
  // first tour run.
  test('every step still shows its real content with zero telescopes configured', async ({ page }) => {
    await page.route('**/api/telescopes/status/all', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok([])),
    }));
    await startTour(page);

    // welcome -> library -> telescopes -> sync.
    await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-label', 'Sync your telescope');
    // The real card must be genuinely visible and interactive, not the old
    // invisible pointer-events:none placeholder.
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveCSS('pointer-events', 'none');
    await expect(dialog.getByText('Once a telescope is set up, open this pill in the top bar and hit Sync.', { exact: false })).toBeVisible();
    // The sync pill is hidden outside the tour when no telescope is configured
    // — which is every fresh install, i.e. everyone taking this tour. Layout
    // renders an inert stand-in for the length of this step so the step has
    // something to point at instead of a card floating over nothing.
    await expect(page.locator('[data-tour-anchor="top-nav-sync"]')).toHaveCount(1);

    // And the rest of the tour must still complete normally from here.
    await walkToEnd(page);
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  test('the final step still shows its real content with Help hidden from the nav', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nebulis-nav-hidden', JSON.stringify(['help']));
      localStorage.setItem('nebulis-nav-forecast-default-seeded-v1', '1');
    });
    await startTour(page);
    await walkToEnd(page); // walks all the way to "done" and clicks Finish.
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  // Another realistic fresh-install state: a telescope is configured (so the
  // "sync" step resolves fine) but nothing has been imported yet, so
  // `next()`'s grabFirstObject lookup (no /object/ links on the Planner page,
  // then a getLibraryObjects() fallback) finds nothing and parks on Library —
  // a page with no `object-processed` anchor at all.
  test('the processed-images step still shows its real content with an empty library', async ({ page }) => {
    await page.route('**/api/library/objects', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok([])),
    }));
    await startTour(page);

    // welcome -> library -> telescopes -> sync -> planner -> processed.
    for (let i = 0; i < 4; i++) {
      await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();
    }

    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-label', 'Your finished images');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveCSS('pointer-events', 'none');
    await expect(page).toHaveURL(/^http:\/\/[^/]+\/$/); // parked on Library
    await expect(dialog.getByText('This is where your finished work lands.', { exact: false })).toBeVisible();

    await walkToEnd(page);
    await expect(page.locator('.nbl-tour')).toHaveCount(0);
  });

  test('the telescopes step anchors on the mobile settings tab strip specifically', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await startTour(page);
    // startTour() already advances welcome -> library (clicking "Start the
    // tour" is that step's Next). One more click reaches telescopes.
    await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();

    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText('Point it at your telescope')).toBeVisible();
    // The desktop sidebar is `hidden` here; the spotlight must be anchored to
    // the mobile tab strip's "Telescopes" tab, which must actually be on screen.
    await expect(page.locator('nav.hidden.lg\\:block')).toBeHidden();
    const mobileTelescopesTab = page.locator('[data-tour-anchor="settings-nav-hardware"]').last();
    await expect(mobileTelescopesTab).toBeVisible();
  });
});
