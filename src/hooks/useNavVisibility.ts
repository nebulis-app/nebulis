import { createContext, useContext, useState, useCallback, useMemo, createElement, type ReactNode } from 'react';

export type NavItemId =
  | 'home'
  | 'library'
  | 'gallery'
  | 'observations'
  | 'forecast'
  | 'planner'
  | 'wishlist'
  | 'catalogs'
  | 'calibrations'
  | 'settings'
  | 'help';

// No `label` here on purpose: this array is built at module load, before any
// component (and its useTranslation() hook) exists, so it cannot carry
// translated text. `labelKey` is resolved by the consumer via t(labelKey) —
// see GeneralSection.tsx / Layout.tsx. Order here is only the *default*
// order for a browser that has never saved one — see `order` below for the
// user-editable order.
export const NAV_ITEMS: { id: NavItemId; labelKey: string }[] = [
  { id: 'home',          labelKey: 'nav.home' },
  { id: 'library',       labelKey: 'nav.library' },
  { id: 'gallery',       labelKey: 'nav.gallery' },
  { id: 'observations',  labelKey: 'nav.observations' },
  { id: 'forecast',      labelKey: 'nav.forecast' },
  { id: 'planner',       labelKey: 'nav.planner' },
  { id: 'wishlist',      labelKey: 'nav.wishlist' },
  { id: 'catalogs',      labelKey: 'nav.catalogs' },
  { id: 'calibrations',  labelKey: 'nav.calibrations' },
  { id: 'settings',      labelKey: 'nav.settings' },
  { id: 'help',          labelKey: 'nav.help' },
];

const NAV_ITEM_IDS = NAV_ITEMS.map(item => item.id);

/** Settings can never be hidden: it's the only way back to this very screen,
 *  and to sign-out/account management. Its position in the bar is still
 *  freely reorderable, only visibility is locked. */
const LOCKED_VISIBLE_ID: NavItemId = 'settings';

const VISIBILITY_STORAGE_KEY = 'nebulis-nav-hidden';
const ORDER_STORAGE_KEY = 'nebulis-nav-order';

/** Nav items that default to hidden as of the change that introduced them,
 *  until the user turns them on in Settings → General. A brand-new browser
 *  has no `STORAGE_KEY` entry at all, so these could just be the fallback
 *  for a missing key — but most real users already have one (even an empty
 *  `[]`, written the first time the provider ever mounted), which would
 *  otherwise mask a new default forever. Each entry has its own seeded-key,
 *  applied once per browser regardless of what's already stored, the same
 *  "seen/applied once" pattern TourProvider uses for its tour-seen flag —
 *  keyed per item (not one shared key for the whole list) so adding a new
 *  hidden-by-default item later doesn't need its own version bump and
 *  doesn't re-seed an item a user already re-enabled. */
const DEFAULT_HIDDEN_SEEDS: { id: NavItemId; seededKey: string }[] = [
  { id: 'forecast',     seededKey: 'nebulis-nav-forecast-default-seeded-v1' },
  { id: 'calibrations', seededKey: 'nebulis-nav-calibrations-default-seeded-v1' },
];

/** The mirror case: an item whose default flipped the other way, from hidden
 *  to shown. A browser seeded by the old default still carries the id in
 *  `nebulis-nav-hidden` (and `DEFAULT_HIDDEN_SEEDS` above deliberately never
 *  revisits a flag it has already set), so without this the item would stay
 *  hidden forever and the new default would reach brand-new browsers only.
 *  Applied once per browser, keyed per item like the hidden seeds. A user who
 *  re-enabled the item by hand has it absent from the stored list already, so
 *  this is a no-op for them; a user who hid it by hand *after* the old seed
 *  sees it come back once, which is the same one-time trade the original
 *  seeding already made. */
const DEFAULT_VISIBLE_SEEDS: { id: NavItemId; seededKey: string }[] = [
  { id: 'wishlist', seededKey: 'nebulis-nav-wishlist-default-visible-v1' },
];

/** Applies both seed lists to a stored hidden set: each flag is read, acted on
 *  and written back exactly once per browser. `store` is `localStorage` in the
 *  browser; tests pass an in-memory stand-in, which is why this is split out
 *  of `getInitialHidden` rather than reading storage directly. */
export function applyDefaultSeeds(
  hidden: Set<NavItemId>,
  store: Pick<Storage, 'getItem' | 'setItem'>,
): { hidden: Set<NavItemId>; changed: boolean } {
  const next = new Set(hidden);
  let changed = false;
  for (const seed of DEFAULT_HIDDEN_SEEDS) {
    if (store.getItem(seed.seededKey) !== '1') {
      next.add(seed.id);
      store.setItem(seed.seededKey, '1');
      changed = true;
    }
  }
  for (const seed of DEFAULT_VISIBLE_SEEDS) {
    if (store.getItem(seed.seededKey) !== '1') {
      next.delete(seed.id);
      store.setItem(seed.seededKey, '1');
      changed = true;
    }
  }
  return { hidden: next, changed };
}

/** Every item hidden by default, for a browser with no storage at all (SSR, or
 *  a storage read that threw). Mirrors what `applyDefaultSeeds` does to an
 *  empty set, minus the seeding flags. */
function defaultHidden(): Set<NavItemId> {
  return new Set(DEFAULT_HIDDEN_SEEDS.map(s => s.id));
}

function getInitialHidden(): Set<NavItemId> {
  if (typeof window === 'undefined') return defaultHidden();
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    const valid = parsed.filter((id): id is NavItemId =>
      NAV_ITEM_IDS.includes(id as NavItemId) && id !== LOCKED_VISIBLE_ID
    );
    const { hidden, changed } = applyDefaultSeeds(new Set(valid), localStorage);
    if (changed) localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify([...hidden]));

    return hidden;
  } catch {
    return defaultHidden();
  }
}

/** A stored order can predate an item (a browser that saved a custom order
 *  before a later version introduced a new nav item, e.g. Wishlist) or
 *  carry a now-removed one. Unknown ids are dropped; anything missing is
 *  inserted right after its `NAV_ITEMS` predecessor via `insertMissing`
 *  rather than always at the very end — a user who once reordered their nav
 *  should still see a new item show up next to where it canonically belongs
 *  (Wishlist after Planner) instead of tacked on after Help. */
function getInitialOrder(): NavItemId[] {
  if (typeof window === 'undefined') return NAV_ITEM_IDS;
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (!raw) return NAV_ITEM_IDS;
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((id): id is NavItemId => NAV_ITEM_IDS.includes(id as NavItemId));
    return insertMissing(valid);
  } catch {
    return NAV_ITEM_IDS;
  }
}

/** Inserts every id from `NAV_ITEM_IDS` that isn't already in `order`,
 *  each placed right after the nearest canonical predecessor that IS
 *  present (falling back to the very start if none of its predecessors
 *  made the cut). Walking `NAV_ITEM_IDS` in order and inserting one at a
 *  time means a run of several new items lands together in their original
 *  relative order, not reversed or interleaved oddly. */
function insertMissing(order: NavItemId[]): NavItemId[] {
  const result = [...order];
  NAV_ITEM_IDS.forEach((id, canonicalIndex) => {
    if (result.includes(id)) return;
    let insertAt = 0;
    for (let j = canonicalIndex - 1; j >= 0; j--) {
      const precedingIndex = result.indexOf(NAV_ITEM_IDS[j]);
      if (precedingIndex !== -1) { insertAt = precedingIndex + 1; break; }
    }
    result.splice(insertAt, 0, id);
  });
  return result;
}

interface NavVisibilityContextValue {
  hidden: Set<NavItemId>;
  isVisible: (id: NavItemId) => boolean;
  toggle: (id: NavItemId) => void;
  /** True only for `settings` today — see `LOCKED_VISIBLE_ID`. */
  isLocked: (id: NavItemId) => boolean;
  order: NavItemId[];
  /** `NAV_ITEMS` re-sorted into the user's saved order. */
  orderedItems: { id: NavItemId; labelKey: string }[];
  /** Moves `id` one slot toward the start (-1) or end (+1) of the order. */
  moveItem: (id: NavItemId, direction: -1 | 1) => void;
  /** Drag-and-drop reorder: pulls `draggedId` out and reinserts it directly
   *  before `targetId`'s current position. */
  reorderItems: (draggedId: NavItemId, targetId: NavItemId) => void;
}

const NavVisibilityContext = createContext<NavVisibilityContextValue | null>(null);

export function NavVisibilityProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState<Set<NavItemId>>(getInitialHidden);
  const [order, setOrder] = useState<NavItemId[]>(getInitialOrder);

  const toggle = useCallback((id: NavItemId) => {
    if (id === LOCKED_VISIBLE_ID) return;
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const isVisible = useCallback((id: NavItemId) => id === LOCKED_VISIBLE_ID || !hidden.has(id), [hidden]);

  const isLocked = useCallback((id: NavItemId) => id === LOCKED_VISIBLE_ID, []);

  const moveItem = useCallback((id: NavItemId, direction: -1 | 1) => {
    setOrder(prev => {
      const index = prev.indexOf(id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const reorderItems = useCallback((draggedId: NavItemId, targetId: NavItemId) => {
    if (draggedId === targetId) return;
    setOrder(prev => {
      if (!prev.includes(draggedId) || !prev.includes(targetId)) return prev;
      const next = prev.filter(id => id !== draggedId);
      const targetIndex = next.indexOf(targetId);
      next.splice(targetIndex, 0, draggedId);
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const orderedItems = useMemo(
    () => order.map(id => NAV_ITEMS.find(item => item.id === id)).filter((item): item is { id: NavItemId; labelKey: string } => Boolean(item)),
    [order]
  );

  const value = useMemo<NavVisibilityContextValue>(
    () => ({ hidden, isVisible, toggle, isLocked, order, orderedItems, moveItem, reorderItems }),
    [hidden, isVisible, toggle, isLocked, order, orderedItems, moveItem, reorderItems]
  );

  return createElement(NavVisibilityContext.Provider, { value }, children);
}

export function useNavVisibility(): NavVisibilityContextValue {
  const ctx = useContext(NavVisibilityContext);
  if (!ctx) throw new Error('useNavVisibility must be used within NavVisibilityProvider');
  return ctx;
}
