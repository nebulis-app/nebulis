// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../src/i18n';
import {
  FilterRecommendationPanel,
  FilterRecommendationChip,
} from '../../src/components/ui/FilterRecommendationPanel';
import enCatalogs from '../../src/locales/en/catalogs.json';
import type { FilterRecommendation } from '../../src/lib/filterRecommendations';

/**
 * Render-level checks for the panel, using react-dom/server rather than a
 * testing library (the repo has no @testing-library/react, and every other
 * frontend test is pure logic). What this covers that the pure-logic tests
 * cannot is the render-time guard: an unrecognised key must degrade to the
 * generic chip instead of indexing the palette table and throwing.
 */
const COPY = enCatalogs.filterRecommendations;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function render(recommendations: FilterRecommendation): string {
  return renderToStaticMarkup(
    <FilterRecommendationPanel recommendations={recommendations} isDark={false} />,
  );
}

describe('FilterRecommendationPanel', () => {
  it('renders the heading and both rig labels', () => {
    const html = render({ color: 'lrgb', mono: 'lrgb' });
    expect(html).toContain(COPY.heading);
    expect(html).toContain(COPY.colorRig);
    expect(html).toContain(COPY.monoRig);
  });

  it('renders the localized chip label for each rig', () => {
    const html = render({ color: 'no-filter-lrgb', mono: 'luminance' });
    expect(html).toContain(COPY.keys['no-filter-lrgb'].label);
    expect(html).toContain(COPY.keys['luminance'].label);
  });

  it('carries each rationale as the chip tooltip', () => {
    const html = render({ color: 'sho', mono: 'sho' });
    expect(html).toContain(`title="${COPY.keys['sho'].rationale}"`);
  });

  it('renders a dark-mode chip without touching the light palette', () => {
    const html = renderToStaticMarkup(
      <FilterRecommendationPanel recommendations={{ color: 'ha-dual', mono: 'sho' }} isDark />,
    );
    expect(html).toContain(COPY.keys['ha-dual'].label);
  });

  it('falls back to the generic chip for a key this build does not know', () => {
    // Simulates a key arriving from a stale cache or a newer server payload.
    const unknownKey = 'ha-sii' as FilterRecommendation['color'];
    let html = '';

    expect(() => {
      html = render({ color: unknownKey, mono: 'lrgb' });
    }).not.toThrow();

    expect(html).toContain(COPY.unknown.label);
    // i18next returns the raw key on a miss, so this also proves the fallback
    // label was used rather than the unresolved key string.
    expect(html).not.toContain('ha-sii');
  });

  it('drops its own surface in the bare variant the object hero uses', () => {
    const boxed = renderToStaticMarkup(
      <FilterRecommendationPanel recommendations={{ color: 'lrgb', mono: 'lrgb' }} isDark={false} />,
    );
    const bare = renderToStaticMarkup(
      <FilterRecommendationPanel recommendations={{ color: 'lrgb', mono: 'lrgb' }} isDark bare />,
    );

    expect(boxed).toContain('bg-slate-50');
    expect(bare).not.toContain('bg-slate-50');
    expect(bare).not.toContain('bg-slate-800/60');
    // Dropping the surface must not drop the content.
    expect(bare).toContain(COPY.heading);
    expect(bare).toContain(COPY.keys['lrgb'].label);
  });

  it('keeps each chip at its own width instead of stretching it across the cell', () => {
    // Regression guard: the chip is a grid item, and a grid item fills its
    // cell by default, which drew the pill the full width of the panel.
    const html = render({ color: 'ha-dual', mono: 'sho' });
    expect(html).toContain('justify-self-start');
  });
});

describe('FilterRecommendationChip (compact, for the Planner row)', () => {
  function renderChip(recommendations: FilterRecommendation): string {
    return renderToStaticMarkup(
      <FilterRecommendationChip recommendations={recommendations} isDark={false} />,
    );
  }

  it('renders the color and mono short labels either side of a slash', () => {
    const html = renderChip({ color: 'no-filter-lrgb', mono: 'luminance' });
    expect(html).toContain(COPY.keys['no-filter-lrgb'].short);
    expect(html).toContain(COPY.keys['luminance'].short);
  });

  it('spells out both rigs in the tooltip', () => {
    const html = renderChip({ color: 'ha-dual', mono: 'sho' });
    expect(html).toContain(COPY.colorRig);
    expect(html).toContain(COPY.monoRig);
    expect(html).toContain(COPY.keys['ha-dual'].label);
    expect(html).toContain(COPY.keys['sho'].label);
  });

  it('shows the short label as the visible text, never the full one', () => {
    const html = renderChip({ color: 'ha-dual', mono: 'sho' });
    // The full label belongs in the tooltip; it must not be the chip text.
    expect(html).not.toContain(`>${COPY.keys['ha-dual'].label}<`);
  });

  it('falls back for a key this build does not know', () => {
    const unknownKey = 'ha-sii' as FilterRecommendation['color'];
    let html = '';
    expect(() => {
      html = renderChip({ color: unknownKey, mono: 'lrgb' });
    }).not.toThrow();
    expect(html).toContain(COPY.unknown.short);
    expect(html).not.toContain('ha-sii');
  });
});
