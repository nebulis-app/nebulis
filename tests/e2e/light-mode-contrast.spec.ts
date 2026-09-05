/**
 * Regression guard for the light-theme contrast work (see docs/light-mode-plan.md).
 *
 * Light mode has no per-component color logic to unit test - it's a handful of
 * CSS custom-property overrides in the `.light` scope of src/index.css. The
 * risk isn't a logic bug, it's someone tweaking a hex value later and quietly
 * dropping a token back below AA. So this asserts real computed contrast
 * ratios (WCAG relative luminance) on representative elements pulled from the
 * live DOM, not on the source hex values.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

async function contrastAgainstAncestorBg(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    function parse(c: string): [number, number, number, number] {
      const m = c.match(/[\d.]+/g);
      if (!m) return [0, 0, 0, 0];
      const [r, g, b, a] = m.map(Number);
      return [r, g, b, a ?? 1];
    }
    function luminance([r, g, b]: [number, number, number, number]): number {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }
    function effectiveBg(node: Element | null): [number, number, number, number] {
      let cur: Element | null = node;
      while (cur) {
        const bg = getComputedStyle(cur).backgroundColor;
        const [r, g, b, a] = parse(bg);
        if (a > 0 && !(r === 0 && g === 0 && b === 0 && a === 0)) return [r, g, b, a];
        cur = cur.parentElement;
      }
      return [255, 255, 255, 1];
    }
    const fg = parse(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test.describe('Light theme contrast', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nebulis-theme', 'light'));
    await mockAllRoutes(page);
  });

  test('primary filled button (bg-accent-500 + white text) passes AA', async ({ page }) => {
    // The Observations calendar/list/map toggle uses bg-accent-500 text-white
    // unconditionally (both themes) - the exact pattern that was 2.15:1 in
    // light mode before the accent-500 token was darkened.
    await page.goto('/observations');
    await page.waitForTimeout(500);
    const ratio = await contrastAgainstAncestorBg(page, 'role=button[name="Calendar"]');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test('active nav link passes AA-large / UI-component contrast', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const ratio = await contrastAgainstAncestorBg(page, 'nav a:has-text("Library")');
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });

  test('muted secondary text ("N objects in library") passes AA', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const ratio = await contrastAgainstAncestorBg(page, 'p:has-text("in library")');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test('page canvas is visibly separated from a raised card', async ({ page }) => {
    await page.goto('/storage');
    await page.waitForTimeout(500);
    const [pageBg, cardBg] = await Promise.all([
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      page.locator('h1:has-text("Storage")').locator('xpath=following::*[contains(@class,"rounded")][1]').evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      ),
    ]);
    expect(pageBg).not.toBe(cardBg);
  });
});
