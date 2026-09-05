import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_TOUR_STEPS } from '../../src/components/tour/steps';
import { SETTINGS_NAV } from '../../src/components/settings/SettingsNav';

/**
 * Static guard for tour step / TourAnchor drift.
 *
 * steps.ts's own editing rules say "every anchorKey must match a
 * <TourAnchor id> in the tree" — this test enforces that automatically
 * instead of relying on someone remembering to check. It complements
 * tests/e2e/tour-full-walkthrough.spec.ts, which catches the runtime half
 * of this (an anchor that exists in source but doesn't actually render at a
 * given viewport/auth state); this one catches the source-level half (an
 * anchorKey that was renamed, typo'd, or had its TourAnchor deleted) far
 * faster, with no browser needed.
 *
 * Anchor ids come from two places:
 *  - Static `<TourAnchor id="...">` usages, found by scanning src/.
 *  - `settings-nav-<group.id>` for every entry in SETTINGS_NAV, generated
 *    dynamically in SettingsNav.tsx rather than written as a literal.
 * If a future anchor host adds a THIRD kind of dynamic id, this test's
 * `knownAnchorIds` needs a matching addition — same as any other constant
 * that intentionally isn't statically greppable.
 */

const SRC_DIR = path.resolve(__dirname, '../../src');

function findStaticAnchorIds(dir: string, out: Set<string> = new Set()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findStaticAnchorIds(full, out);
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;
    const contents = fs.readFileSync(full, 'utf8');
    for (const match of contents.matchAll(/TourAnchor\s+id="([^"]+)"/g)) {
      out.add(match[1]);
    }
  }
  return out;
}

describe('tour anchors stay in sync with steps.ts', () => {
  it('every non-welcome step anchorKey resolves to a real TourAnchor', () => {
    const staticIds = findStaticAnchorIds(SRC_DIR);
    const settingsNavIds = new Set(SETTINGS_NAV.map(g => `settings-nav-${g.id}`));
    const knownAnchorIds = new Set([...staticIds, ...settingsNavIds]);

    // The welcome card is intentionally anchorless (TourOverlay special-cases
    // it, per steps.ts's own doc comment) — every other step must resolve.
    const missing = ALL_TOUR_STEPS
      .filter(s => s.id !== 'welcome')
      .filter(s => !knownAnchorIds.has(s.anchorKey))
      .map(s => `${s.id} -> "${s.anchorKey}"`);

    expect(missing, `Tour steps with no matching TourAnchor: ${missing.join(', ')}`).toEqual([]);
  });

  it('every step with a route has that route render its anchor (no orphaned routes)', () => {
    // Sanity check on the fixture itself: catches a step whose `route` was
    // typo'd to a page that doesn't exist among the app's actual routes,
    // which would otherwise navigate the tour into a 404 silently.
    const appTsx = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
    const declaredRoutes = new Set(
      [...appTsx.matchAll(/<Route path="([^"]+)"/g)].map(m => m[1]),
    );

    const badRoutes = ALL_TOUR_STEPS
      .filter(s => s.route)
      .filter(s => {
        const route = s.route as string;
        // Static routes match exactly; nothing in steps.ts targets a
        // param'd route today, so an exact match is the right bar.
        return !declaredRoutes.has(route);
      })
      .map(s => `${s.id} -> "${s.route}"`);

    expect(badRoutes, `Tour steps pointing at an undeclared route: ${badRoutes.join(', ')}`).toEqual([]);
  });
});
