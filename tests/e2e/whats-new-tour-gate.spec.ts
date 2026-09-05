import { test, expect } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

/**
 * Regression coverage for the guided tour auto-launching on top of the
 * "What's New" popup on a fresh install.
 *
 * Two bugs were fixed here:
 *  1. TourProvider.autoStart used to fire the instant onboarding closed,
 *     completely independent of WhatsNewAutoPopup's own version-comparison
 *     trigger — on a fresh install both showed at once and stacked.
 *  2. The fix for #1 (a WhatsNewGateContext the tour waits on) introduced a
 *     second bug: acknowledging the reel ("Got it") persists lastSeenVersion
 *     server-side and invalidates that query mid-chain, so `seen` catches up
 *     to `current` while the popup is still open (now showing the full
 *     changelog instead of the reel) — a naive effect re-run read that as
 *     "nothing to show" and released the gate under the still-open modal.
 *
 * This test drives the exact fresh-install path (skip onboarding, land on
 * the v2.0 reel, acknowledge into the full changelog, dismiss) and asserts
 * the tour overlay is absent at every point until the popup chain is fully
 * closed.
 */
test.describe('Guided tour vs What\'s New gating', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('nebulis-tour-seen-v1'));
    await mockAllRoutes(page);

    // Fresh install: no admin account yet, so App.tsx renders OnboardingModal.
    await page.route('**/api/auth/status', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok({ hasUsers: false, requiresSetup: true })),
    }));

    await page.route('**/api/meta/version', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ok({ version: '2.0.0', shortVersion: '2.0', build: 233 })),
    }));

    // Stateful last-seen-version: starts unset (never acknowledged anything),
    // and the PUT that "Got it" issues persists it server-side — this
    // statefulness is what actually exercises the query-invalidation race in
    // bug #2 above. A route that always returns null would never catch it.
    let lastSeenVersion: string | null = null;
    await page.route('**/api/preferences/last-seen-version', async r => {
      if (r.request().method() === 'PUT') {
        const body = JSON.parse(r.request().postData() || '{}') as { version: string };
        lastSeenVersion = body.version;
      }
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({ lastSeenVersion })),
      });
    });
  });

  test('tour never renders behind the auto What\'s New popup on a fresh install', async ({ page }) => {
    await page.goto('/');

    // Land on the onboarding wizard and skip it — the fastest legitimate path
    // to onboardingDismissed=true, which is what arms the tour's autoStart.
    await expect(page.getByText('Create Admin Account')).toBeVisible();
    await page.getByRole('button', { name: 'Set up later' }).click();

    // The v2.0 screenshot reel opens automatically (never-seen-before version).
    // Modal renders both a visually-hidden accessible title and the real
    // heading with the same text, so exclude .sr-only to keep this strict.
    const reelHeading = page.locator('h2:not(.sr-only)', { hasText: 'What\'s new in Nebulis 2.0' });
    await expect(reelHeading).toBeVisible();
    // The guided tour must NOT be present underneath it.
    await expect(page.locator('.nbl-tour')).toHaveCount(0);

    // "Got it" persists the ack (PUT above) and chains straight into the full
    // changelog instead of closing. This is the exact moment bug #2 fired:
    // the lastSeenVersion query catching up to `current` mid-chain.
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.locator('p:not(.sr-only)', { hasText: 'Release history' })).toBeVisible();
    await expect(page.locator('.nbl-tour')).toHaveCount(0);

    // Only dismissing the full changelog actually ends the chain — the tour
    // may auto-start now, and should.
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Meet Nebulis')).toBeVisible();
  });

  test('tour auto-starts once the popup is dismissed with "Remind me later"', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Set up later' }).click();

    const reelHeading = page.locator('h2:not(.sr-only)', { hasText: 'What\'s new in Nebulis 2.0' });
    await expect(reelHeading).toBeVisible();
    await expect(page.locator('.nbl-tour')).toHaveCount(0);

    // "Remind me later" closes without acknowledging — no query-invalidation
    // race here, just the plain settle-on-close path.
    await page.getByRole('button', { name: 'Remind me later' }).click();
    await expect(page.getByText('What\'s new in Nebulis 2.0')).toHaveCount(0);
    await expect(page.getByText('Meet Nebulis')).toBeVisible();
  });
});
