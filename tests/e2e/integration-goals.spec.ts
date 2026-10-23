import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockViewerAuth, json, ok } from './fixtures/mocks';

/**
 * Integration per filter, goals and filter aliases.
 *
 * The object page's Integration card adds up exposure per filter across nights
 * and sets it against a goal per filter ("10 h Ha"). Filter names are tidied by
 * aliases (Settings → Library) so "H-alpha" and "Ha" count together. The sums
 * are the server's (server/lib/library/integration.ts); these specs pin what the
 * card shows and what saving a goal or an alias sends.
 */

const night = (date: string, frames: number, exposureSec: number) => ({ date, frames, exposureSec });

const breakdown = {
  objectId: 'M42',
  totalFrames: 192,
  totalExposureSec: 40800,
  unreadableFrames: 0,
  filters: [
    // 7h 20m shot of a 10 h goal: 2h 40m left, 73%.
    { filter: 'Ha', frames: 132, exposureSec: 26400, goalSec: 36000, nights: [night('2024-03-15', 80, 16000), night('2024-03-10', 52, 10400)] },
    // Exactly at its goal.
    { filter: 'OIII', frames: 40, exposureSec: 10800, goalSec: 10800, nights: [night('2024-03-15', 40, 10800)] },
    // Shot with no goal set.
    { filter: 'L', frames: 20, exposureSec: 3600, goalSec: null, nights: [] },
  ],
};

async function mockIntegration(page: Page, data: unknown = breakdown) {
  const saved: { body: Record<string, unknown> | null } = { body: null };
  await page.route('**/api/library/objects/M42/integration/filters', r => r.fulfill(json(ok(data))));
  await page.route('**/api/library/objects/M42/integration/goals', async r => {
    saved.body = r.request().postDataJSON();
    await r.fulfill(json(ok((saved.body as { goals: unknown[] }).goals)));
  });
  await page.route('**/api/library/integration/progress', r => r.fulfill(json(ok([]))));
  return saved;
}

test.describe('Object page: Integration by filter', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('shows each filter with its frames, its time and where it stands against its goal', async ({ page }) => {
    await mockIntegration(page);
    await page.goto('/object/M42');

    const card = page.getByRole('button', { name: /^Integration/ });
    await expect(card).toContainText('11h 20m · 3 filters');

    const ha = page.getByRole('button', { name: /^Ha\b.*132 frames/ });
    await expect(ha).toContainText('7h 20m');
    await expect(ha).toContainText('/ 10h');
    await expect(ha).toContainText('2h 40m left · 73%');
    await expect(page.getByRole('progressbar', { name: 'Ha' })).toHaveAttribute('aria-valuenow', '73');
  });

  test('a filter at its goal says so', async ({ page }) => {
    await mockIntegration(page);
    await page.goto('/object/M42');
    await expect(page.getByRole('button', { name: /^OIII\b/ })).toContainText('Goal reached');
  });

  test('a filter with no goal shows only what was shot', async ({ page }) => {
    await mockIntegration(page);
    await page.goto('/object/M42');
    const luminance = page.getByRole('button', { name: /^L\b.*20 frames/ });
    await expect(luminance).toContainText('1h');
    await expect(luminance).not.toContainText('left');
    await expect(page.getByRole('progressbar', { name: 'L' })).toHaveCount(0);
  });

  test('opening a filter lists its nights', async ({ page }) => {
    await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: /^Ha\b.*132 frames/ }).click();
    await expect(page.getByText('Mar 15, 2024')).toBeVisible();
    await expect(page.getByText('Mar 10, 2024')).toBeVisible();
    await expect(page.getByText('80 frames')).toBeVisible();
  });

  test('an object with no sub-frames says "None yet"', async ({ page }) => {
    await mockIntegration(page, { objectId: 'M42', totalFrames: 0, totalExposureSec: 0, unreadableFrames: 0, filters: [] });
    await page.goto('/object/M42');
    await expect(page.getByRole('button', { name: /^Integration/ })).toContainText('None yet');
  });

  test('frames that could not be read are called out, not silently dropped', async ({ page }) => {
    await mockIntegration(page, { ...breakdown, unreadableFrames: 3 });
    await page.goto('/object/M42');
    await expect(page.getByText('3 sub-frames could not be read and are not counted.')).toBeVisible();
  });
});

test.describe('Object page: setting goals', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('editing starts from the current goals, in hours', async ({ page }) => {
    await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await expect(page.getByLabel('Goal in hours for Ha')).toHaveValue('10');
    await expect(page.getByLabel('Goal in hours for OIII')).toHaveValue('3');
    await expect(page.getByLabel('Goal in hours for L')).toHaveValue('');
  });

  test('saving sends every filter\'s goal in seconds', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByLabel('Goal in hours for Ha').fill('12');
    await page.getByLabel('Goal in hours for L').fill('2');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => saved.body).toEqual({
      goals: [
        { filter: 'Ha', goalSec: 43200 },
        { filter: 'OIII', goalSec: 10800 },
        { filter: 'L', goalSec: 7200 },
      ],
    });
    // Back to the read view.
    await expect(page.getByLabel('Goal in hours for Ha')).toHaveCount(0);
  });

  test('a goal of 0 or an empty one removes it', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByLabel('Goal in hours for OIII').fill('0');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => (saved.body as { goals: { filter: string; goalSec: number }[] } | null)?.goals
      .find(g => g.filter === 'OIII')).toEqual({ filter: 'OIII', goalSec: 0 });
  });

  test('a filter can be added before anything is shot through it', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByLabel('Filter name').fill('SII');
    await page.getByLabel('Goal in hours for SII').fill('4');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => (saved.body as { goals: { filter: string; goalSec: number }[] } | null)?.goals
      .find(g => g.filter === 'SII')).toEqual({ filter: 'SII', goalSec: 14400 });
  });

  test('refuses hours that are not a number, and saves nothing', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByLabel('Goal in hours for Ha').fill('lots');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Enter a number of hours between 0 and 1000.')).toBeVisible();
    expect(saved.body).toBeNull();
  });

  test('refuses a goal on a filter with no name', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByLabel(/Goal in hours for/).last().fill('5');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Give the new filter a name.')).toBeVisible();
    expect(saved.body).toBeNull();
  });

  test('Cancel leaves the goals as they were', async ({ page }) => {
    const saved = await mockIntegration(page);
    await page.goto('/object/M42');
    await page.getByRole('button', { name: 'Goals' }).click();
    await page.getByLabel('Goal in hours for Ha').fill('99');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Goal in hours for Ha')).toHaveCount(0);
    expect(saved.body).toBeNull();
  });

  test('a viewer can read the card but cannot set goals', async ({ page }) => {
    await mockViewerAuth(page);
    await mockIntegration(page);
    await page.goto('/object/M42');
    await expect(page.getByRole('button', { name: /^Integration/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Goals' })).toHaveCount(0);
  });
});

test.describe('Settings → Library: filter aliases', () => {
  type Alias = { alias: string; canonical: string };

  async function mockAliases(page: Page, initial: Alias[]) {
    const saved: { body: { aliases: Alias[] } | null } = { body: null };
    await page.route('**/api/library/filter-aliases', async r => {
      if (r.request().method() === 'PUT') {
        saved.body = r.request().postDataJSON();
        return r.fulfill(json(ok(saved.body!.aliases)));
      }
      return r.fulfill(json(ok(initial)));
    });
    return saved;
  }

  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('says so when there are no aliases', async ({ page }) => {
    await mockAliases(page, []);
    await page.goto('/settings?tab=library&section=organization');
    await expect(page.getByText('Filter aliases', { exact: true })).toBeVisible();
    await expect(page.getByText('No aliases yet.')).toBeVisible();
  });

  test('lists saved aliases', async ({ page }) => {
    await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await expect(page.getByRole('textbox', { name: 'Name in your files', exact: true })).toHaveValue('Slot 3');
    await expect(page.getByRole('textbox', { name: 'Count as', exact: true })).toHaveValue('OIII');
  });

  test('Save only appears once something changed', async ({ page }) => {
    await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await expect(page.getByRole('button', { name: 'Save aliases' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Count as', exact: true }).fill('SII');
    await expect(page.getByRole('button', { name: 'Save aliases' })).toBeVisible();
  });

  test('adds an alias and saves it', async ({ page }) => {
    const saved = await mockAliases(page, []);
    await page.goto('/settings?tab=library&section=organization');
    await page.getByRole('button', { name: 'Add alias' }).click();
    await page.getByRole('textbox', { name: 'Name in your files', exact: true }).fill('  Slot 3 ');
    await page.getByRole('textbox', { name: 'Count as', exact: true }).fill('OIII');
    await page.getByRole('button', { name: 'Save aliases' }).click();
    // Trimmed on the way out.
    await expect.poll(() => saved.body).toEqual({ aliases: [{ alias: 'Slot 3', canonical: 'OIII' }] });
    await expect(page.getByRole('button', { name: 'Save aliases' })).toHaveCount(0);
  });

  test('a half-filled row is dropped rather than saved', async ({ page }) => {
    const saved = await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await page.getByRole('button', { name: 'Add alias' }).click();
    await page.getByRole('textbox', { name: 'Name in your files', exact: true }).last().fill('Orphan');
    await page.getByRole('button', { name: 'Save aliases' }).click();
    await expect.poll(() => saved.body).toEqual({ aliases: [{ alias: 'Slot 3', canonical: 'OIII' }] });
  });

  test('removing an alias saves the shorter list', async ({ page }) => {
    const saved = await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }, { alias: 'Slot 4', canonical: 'SII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await page.getByRole('button', { name: 'Remove alias' }).first().click();
    await page.getByRole('button', { name: 'Save aliases' }).click();
    await expect.poll(() => saved.body).toEqual({ aliases: [{ alias: 'Slot 4', canonical: 'SII' }] });
  });

  test('Cancel throws the edits away', async ({ page }) => {
    const saved = await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await page.getByRole('textbox', { name: 'Count as', exact: true }).fill('SII');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('textbox', { name: 'Count as', exact: true })).toHaveValue('OIII');
    expect(saved.body).toBeNull();
  });

  test('a viewer can read the aliases but not edit them', async ({ page }) => {
    await mockViewerAuth(page);
    await mockAliases(page, [{ alias: 'Slot 3', canonical: 'OIII' }]);
    await page.goto('/settings?tab=library&section=organization');
    await expect(page.getByRole('textbox', { name: 'Name in your files', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add alias' })).toHaveCount(0);
  });
});
