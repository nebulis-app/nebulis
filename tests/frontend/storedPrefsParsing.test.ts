// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  readFovSetup,
  readSavedCustomRigs,
  DEFAULT_CUSTOM_OPTICS,
} from '../../src/lib/telescopeFov';
import { NavVisibilityProvider, useNavVisibility, NAV_ITEMS } from '../../src/hooks/useNavVisibility';

// localStorage is user-writable and survives app versions, so every reader of it
// must survive whatever is in there. These pin the malformed-payload paths of the
// FOV/custom-rig readers and the nav-visibility provider (whose isNavItemId guard
// is private; it is exercised through the provider's initial state).

const FOV_KEY = 'nebulis-fov-setup';
const RIGS_KEY = 'nebulis-saved-custom-rigs';
const HIDDEN_KEY = 'nebulis-nav-hidden';
const ORDER_KEY = 'nebulis-nav-order';
const ALL_SEEDED = [
  'nebulis-nav-forecast-default-seeded-v1',
  'nebulis-nav-calibrations-default-seeded-v1',
  'nebulis-nav-wishlist-default-visible-v1',
];

const GOOD_OPTICS = { focalMm: 400, sensorWMm: 23.5, sensorHMm: 15.7, pixelSizeUm: 3.76 };

beforeEach(() => {
  localStorage.clear();
});

describe('readFovSetup with malformed storage', () => {
  it.each(['null', '42', '"seestar"', '[]'])('falls back to defaults for non-object JSON %s', (raw) => {
    localStorage.setItem(FOV_KEY, raw);
    expect(readFovSetup()).toEqual({ profileId: null, custom: DEFAULT_CUSTOM_OPTICS });
  });

  it('keeps a string profileId but drops a non-string one', () => {
    localStorage.setItem(FOV_KEY, JSON.stringify({ profileId: 'seestar-s50', custom: GOOD_OPTICS }));
    expect(readFovSetup().profileId).toBe('seestar-s50');
    localStorage.setItem(FOV_KEY, JSON.stringify({ profileId: 7, custom: GOOD_OPTICS }));
    expect(readFovSetup().profileId).toBeNull();
  });

  it('replaces custom optics with defaults when a required dimension is not a number', () => {
    localStorage.setItem(FOV_KEY, JSON.stringify({ profileId: 'custom', custom: { ...GOOD_OPTICS, focalMm: '400' } }));
    expect(readFovSetup()).toEqual({ profileId: 'custom', custom: DEFAULT_CUSTOM_OPTICS });
  });

  it('reads a missing or non-numeric pixel pitch as null, keeping the rest', () => {
    localStorage.setItem(FOV_KEY, JSON.stringify({ profileId: null, custom: { ...GOOD_OPTICS, pixelSizeUm: 'n/a' } }));
    expect(readFovSetup().custom).toEqual({ ...GOOD_OPTICS, pixelSizeUm: null });
  });
});

describe('readSavedCustomRigs with malformed storage', () => {
  it.each(['{not json', '{"id":"a"}', 'null', '"rig"'])('returns [] for %s', (raw) => {
    localStorage.setItem(RIGS_KEY, raw);
    expect(readSavedCustomRigs()).toEqual([]);
  });

  it('keeps valid rigs and drops entries with a bad id, name, or optics', () => {
    localStorage.setItem(RIGS_KEY, JSON.stringify([
      { id: 'a', name: 'Good', optics: GOOD_OPTICS },
      { id: 1, name: 'Numeric id', optics: GOOD_OPTICS },
      { id: 'c', optics: GOOD_OPTICS },
      { id: 'd', name: 'No optics' },
      { id: 'e', name: 'Bad optics', optics: { focalMm: 400 } },
      null,
      'f',
    ]));
    expect(readSavedCustomRigs()).toEqual([{ id: 'a', name: 'Good', optics: GOOD_OPTICS }]);
  });
});

/** Render the provider once and return its context value. */
function readNavState(): ReturnType<typeof useNavVisibility> {
  let captured: ReturnType<typeof useNavVisibility> | null = null;
  function Probe() {
    captured = useNavVisibility();
    return null;
  }
  renderToStaticMarkup(createElement(NavVisibilityProvider, null, createElement(Probe)));
  return captured!;
}

function markAllSeeded(): void {
  for (const k of ALL_SEEDED) localStorage.setItem(k, '1');
}

describe('NavVisibilityProvider initial state from storage', () => {
  it('drops unknown ids, non-strings, and the locked settings id from the hidden list', () => {
    markAllSeeded();
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['gallery', 'removed-item', 3, null, 'settings']));

    const nav = readNavState();

    expect([...nav.hidden]).toEqual(['gallery']);
    expect(nav.isVisible('settings')).toBe(true);
  });

  it('treats a non-array hidden payload as the default hidden set', () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ gallery: true }));
    expect([...readNavState().hidden].sort()).toEqual(['calibrations', 'forecast']);
  });

  it('treats invalid hidden JSON as the default hidden set', () => {
    localStorage.setItem(HIDDEN_KEY, '[gallery');
    expect([...readNavState().hidden].sort()).toEqual(['calibrations', 'forecast']);
  });

  it('drops unknown order ids and reinserts missing ones after their canonical predecessor', () => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(['help', 'bogus', 7, 'library', 'planner']));

    const order = readNavState().order;

    expect(order).toEqual([
      'help', 'library', 'gallery', 'observations', 'forecast',
      'planner', 'wishlist', 'explore', 'catalogs', 'calibrations', 'settings',
    ]);
  });

  it('falls back to the canonical order for a non-array or unparseable order payload', () => {
    const canonical = NAV_ITEMS.map(i => i.id);
    localStorage.setItem(ORDER_KEY, '"library"');
    expect(readNavState().order).toEqual(canonical);
    localStorage.setItem(ORDER_KEY, '{oops');
    expect(readNavState().order).toEqual(canonical);
  });
});
