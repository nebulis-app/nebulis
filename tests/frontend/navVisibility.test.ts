import { describe, it, expect } from 'vitest';
import { applyDefaultSeeds, applyWishlistMerge, type NavItemId } from '../../src/hooks/useNavVisibility';

/**
 * The top nav's visibility defaults, which are localStorage-seeded rather than
 * plain fallbacks: most browsers already hold a `nebulis-nav-hidden` list, so a
 * changed default reaches an existing user only through the per-item seed flags
 * `applyDefaultSeeds` maintains. These tests pin the current defaults (Forecast
 * and Calibrations off) and the way seeding can go wrong: re-hiding an item a
 * user turned back on. They also pin the one-time Wishlist-into-Explore merge,
 * which must not leave someone who used Wishlist with no way to reach it.
 */
const FORECAST_SEED = 'nebulis-nav-forecast-default-seeded-v1';
const CALIBRATIONS_SEED = 'nebulis-nav-calibrations-default-seeded-v1';
const WISHLIST_MERGE_SEED = 'nebulis-nav-wishlist-merged-into-explore-v1';

/** Stand-in for localStorage. */
function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

function ids(hidden: Set<NavItemId>): NavItemId[] {
  return [...hidden].sort();
}

describe('top nav visibility defaults', () => {
  it('hides Forecast and Calibrations on a browser with no storage', () => {
    const store = fakeStore();
    const { hidden } = applyDefaultSeeds(new Set(), store);

    expect(ids(hidden)).toEqual(['calibrations', 'forecast']);
    // Settings is the one item that can never be hidden (it is the way back to
    // this very setting), so no seed may ever add it.
    expect(hidden.has('settings')).toBe(false);
  });

  it('seeds each flag once, so a second pass changes nothing', () => {
    const store = fakeStore();
    const first = applyDefaultSeeds(new Set(), store);
    expect(first.changed).toBe(true);

    const second = applyDefaultSeeds(first.hidden, store);
    expect(second.changed).toBe(false);
    expect(ids(second.hidden)).toEqual(ids(first.hidden));
  });

  it('does not re-hide an item the user turned back on after its seed ran', () => {
    // Calibrations seeded off, then turned on by hand: the seed flag is set and
    // the stored list no longer carries the id. Seeding must not re-add it.
    const store = fakeStore({ [CALIBRATIONS_SEED]: '1', [FORECAST_SEED]: '1' });
    const { hidden, changed } = applyDefaultSeeds(new Set(['forecast']), store);

    expect(changed).toBe(false);
    expect(hidden.has('calibrations')).toBe(false);
  });
});

describe('Wishlist merged into Explore', () => {
  it('shows Explore for someone who kept Wishlist in the bar but had hidden Explore', () => {
    const store = fakeStore();
    const { hidden, changed } = applyWishlistMerge(['explore', 'forecast'], new Set(['explore', 'forecast']), store);

    expect(changed).toBe(true);
    expect(ids(hidden)).toEqual(['forecast']);
    expect(store.getItem(WISHLIST_MERGE_SEED)).toBe('1');
  });

  it('leaves Explore hidden when Wishlist was hidden too', () => {
    const store = fakeStore();
    const { hidden, changed } = applyWishlistMerge(['explore', 'wishlist'], new Set(['explore']), store);

    expect(changed).toBe(false);
    expect(hidden.has('explore')).toBe(true);
  });

  it('runs once, so hiding Explore again afterwards sticks', () => {
    const store = fakeStore({ [WISHLIST_MERGE_SEED]: '1' });
    const { hidden, changed } = applyWishlistMerge(['explore'], new Set(['explore']), store);

    expect(changed).toBe(false);
    expect(hidden.has('explore')).toBe(true);
  });
});
