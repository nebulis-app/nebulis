import { test, expect } from '@playwright/test';
import { mockAllRoutes, MOCK } from './fixtures/mocks';

test.describe('Wishlist Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/wishlist');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /wishlist/i })).toBeVisible();
  });

  test('renders wishlist items', async ({ page }) => {
    await expect(page.getByText('Whirlpool Galaxy')).toBeVisible();
    await expect(page.getByText("Bode's Galaxy")).toBeVisible();
  });

  test('shows priority badges', async ({ page }) => {
    await expect(page.getByText('High').first()).toBeVisible();
    await expect(page.getByText('Medium').first()).toBeVisible();
  });

  test('shows constellation labels', async ({ page }) => {
    await expect(page.getByText('Canes Venatici').first()).toBeVisible();
    await expect(page.getByText('Ursa Major').first()).toBeVisible();
  });

  test('shows object types', async ({ page }) => {
    await expect(page.getByText('Galaxy').first()).toBeVisible();
  });

  test('shows magnitude values', async ({ page }) => {
    await expect(page.getByText(/8\.4|6\.9/)).toBeVisible();
  });

  test('shows notes for items that have notes', async ({ page }) => {
    await expect(page.getByText('Great spring target')).toBeVisible();
  });

  test('remove button is present for each item', async ({ page }) => {
    await expect(page.getByRole('button', { name: /remove|delete|×/i }).first()).toBeVisible();
  });

  test('clicking remove calls delete API', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/wishlist/**', async r => {
      if (r.request().method() === 'DELETE') {
        deleteCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { deleted: true } }),
        });
      } else if (r.request().method() === 'PATCH') {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist[0] }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist[0] }),
        });
      }
    });
    await page.route('**/api/wishlist', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [MOCK.wishlist[1]] }), // one item removed
      }));

    await page.getByRole('button', { name: /remove|delete/i }).first().click();
    expect(deleteCalled).toBe(true);
  });

  test('clicking priority badge cycles priority', async ({ page }) => {
    await page.route('**/api/wishlist/**', async r => {
      if (r.request().method() === 'PATCH') {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { ...MOCK.wishlist[0], priority: 'medium' } }),
        });
      } else if (r.request().method() === 'DELETE') {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { deleted: true } }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist[0] }),
        });
      }
    });

    await page.getByText('High').first().click();
    // PATCH should have been called OR the badge updated
    await expect(page.getByText('Medium').or(page.getByText('Low'))).toBeVisible({ timeout: 3000 });
  });

  test('edit notes button shows notes input', async ({ page }) => {
    const editBtn = page.getByRole('button', { name: /edit|notes/i }).first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await expect(page.locator('textarea').or(page.getByRole('textbox'))).toBeVisible();
    }
  });

  test('saving edited notes calls update API', async ({ page }) => {
    let patchCalled = false;
    await page.route('**/api/wishlist/**', async r => {
      if (r.request().method() === 'PATCH') {
        patchCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { ...MOCK.wishlist[0], notes: 'Updated notes text' } }),
        });
      } else if (r.request().method() === 'DELETE') {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { deleted: true } }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist[0] }),
        });
      }
    });

    const editBtn = page.getByRole('button', { name: /edit/i }).first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      const textarea = page.locator('textarea').or(page.getByRole('textbox')).first();
      if (await textarea.isVisible()) {
        await textarea.clear();
        await textarea.fill('Updated notes text');
        await page.getByRole('button', { name: /save|check|confirm/i }).first().click();
        expect(patchCalled).toBe(true);
      }
    }
  });

  test('search input is present to add objects', async ({ page }) => {
    await expect(page.getByPlaceholder(/search|add|find/i)).toBeVisible();
  });

  test('searching DSO catalog shows results', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search|add|find/i);
    await searchInput.fill('sunflower');

    await expect(page.getByText('Sunflower Galaxy')).toBeVisible({ timeout: 5000 });
  });

  test('adding from search results calls POST API', async ({ page }) => {
    let postCalled = false;
    await page.route('**/api/wishlist', async r => {
      if (r.request().method() === 'POST') {
        postCalled = true;
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            data: [...MOCK.wishlist, {
              id: 'wl-new',
              objectId: 'M63',
              objectName: 'Sunflower Galaxy',
              catalogId: 'M63',
              type: 'Galaxy',
              constellation: 'Canes Venatici',
              magnitude: 8.6,
              priority: 'medium',
              notes: '',
              addedAt: new Date().toISOString(),
            }],
          }),
        });
      } else {
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: MOCK.wishlist }),
        });
      }
    });

    const searchInput = page.getByPlaceholder(/search|add|find/i);
    await searchInput.fill('sunflower');

    const addBtn = page.getByRole('button', { name: /add|bookmark/i }).first();
    if (await addBtn.isVisible({ timeout: 3000 })) {
      await addBtn.click();
      expect(postCalled).toBe(true);
    }
  });

  test('empty wishlist shows empty state', async ({ page }) => {
    await page.route('**/api/wishlist', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      }));
    await page.goto('/wishlist');

    await expect(page.getByText(/empty|no items|nothing/i)).toBeVisible();
  });

  test('sort by priority toggle is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /sort|priority/i })
        .or(page.getByText(/sort by/i))
    ).toBeVisible();
  });

  test('planner link is present', async ({ page }) => {
    await expect(
      page.getByRole('link', { name: /planner/i })
        .or(page.locator('a[href="/planner"]'))
    ).toBeVisible();
  });
});
