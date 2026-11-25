/**
 * UI settings that follow the user rather than the browser.
 *
 * Components keep reading their settings from localStorage, synchronously, so the first paint never waits on the
 * network. What changes is where those values come from and where writes go:
 *
 *  - Writes to a synced key go through `setUiSetting` / `removeUiSetting`. They land in localStorage at once and
 *    are sent to the server shortly after, grouped into one `PATCH /preferences/ui`.
 *  - At sign-in, `hydrateUiSettings` loads the server's copy into localStorage before the app shell mounts, so every
 *    page reads the user's settings even after site data was cleared or in a browser they have never used. Synced
 *    keys this browser has and the server lacks are sent up, which is also how settings saved before this existed
 *    reach the server the first time.
 *
 * Only the keys listed here are synced. Some settings stay with the browser on purpose: the auth token, the UI scale
 * (it depends on the screen, see useUiScale.ts), and anything in sessionStorage.
 */
import i18n, { LANGUAGE_STORAGE_KEY } from '../i18n';
import { fetchJSON, getAuthToken } from './api/client';

/** Fired on window once the server's settings are in localStorage, so state built before that (theme, nav) can re-read. */
export const UI_SETTINGS_HYDRATED_EVENT = 'nebulis:ui-settings-hydrated';

const SYNCED_KEYS = new Set<string>([
  // Appearance and language
  'nebulis-theme',
  'nebulis-nebula-backdrop',
  LANGUAGE_STORAGE_KEY,
  'nebulis-compact-banners',
  // Navigation
  'nebulis-nav-hidden',
  'nebulis-nav-order',
  'nebulis-nav-forecast-default-seeded-v1',
  'nebulis-nav-calibrations-default-seeded-v1',
  'nebulis-nav-wishlist-merged-into-explore-v1',
  // Library and gallery
  'nebulis-library-layout',
  'nebulis-library-sort',
  'nebulis-library-group',
  'nebulis-library-collapsed-groups',
  'nebulis-library-columns',
  'nebulis-gallery-sort',
  'nebulis-gallery-layout',
  'nebulis-mosaic-labels',
  'nebulis_media_tile_size',
  'nebulis_media_subs_view',
  'nebulis_media_hide_fits',
  'nebulis_frame_list_previews',
  'nebulis_annotation_dock_minimized',
  'nebulis_import_recent_paths',
  // Objects and observations
  'nebulis.objectDetail.observationsGroupBy',
  'nebulis.integrationSuggest.telescope',
  'nebulis.observationDetails',
  'nebulis_calendar_show_planned',
  // Catalogs, framing and planning
  'catalogs.hidden',
  'catalogs.observableOnly',
  'catalogs.wallObservableOnly',
  'nebulis_wall_poster_subtitle',
  'nebulis-fov-setup',
  'nebulis-saved-custom-rigs',
  'nebulis-explore-site',
  'nebulis-planner-target-order',
  'planner.narrowbandCapable',
  // One-time notices, so they do not come back after site data is cleared
  'nebulis-tour-seen-v1',
  'nebulis_mobile_promo_dismissed',
]);

/** Keys built at runtime: one per banner, one per completed library migration. */
const SYNCED_PATTERNS: RegExp[] = [
  /^nebulis-.+-hero-collapsed$/,
  /^nebulis_migration_seen_.+$/,
];

export function isSyncedUiSetting(key: string): boolean {
  return SYNCED_KEYS.has(key) || SYNCED_PATTERNS.some(re => re.test(key));
}

const FLUSH_DELAY_MS = 400;

/** Changes not yet accepted by the server. null means "remove". */
let pending: Record<string, string | null> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
/** False until the server's copy has been loaded: writes made before that stay local, so a default written while the
 *  app boots cannot overwrite the user's saved value. hydrateUiSettings sends up whatever the server still lacks. */
let hydrated = false;

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked: the server copy (if any) still carries it */ }
}

function syncing(): boolean {
  return hydrated && getAuthToken() !== null;
}

function queue(key: string, value: string | null): void {
  if (!isSyncedUiSetting(key) || !syncing()) return;
  pending[key] = value;
  if (flushTimer === null) flushTimer = setTimeout(() => { void flushUiSettings(); }, FLUSH_DELAY_MS);
}

/** Store a UI setting in this browser and, for a synced key, on the server. Never throws. */
export function setUiSetting(key: string, value: string): void {
  // Once hydrated, localStorage mirrors the server, so an unchanged value (a provider re-saving its state on mount)
  // has nothing to send.
  if (readLocal(key) === value) return;
  writeLocal(key, value);
  queue(key, value);
}

/** Remove a UI setting here and, for a synced key, on the server. Never throws. */
export function removeUiSetting(key: string): void {
  writeLocal(key, null);
  queue(key, null);
}

/** A Storage-shaped view whose writes sync, for helpers that take a `store` argument (see useNavVisibility). */
export const uiSettingsStore: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: readLocal,
  setItem: setUiSetting,
};

/** Send queued changes now. A failed send keeps them queued for the next change or page hide; it never throws. */
export async function flushUiSettings(options: { keepalive?: boolean } = {}): Promise<void> {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  if (flushing) await flushing;
  if (!syncing() || Object.keys(pending).length === 0) return;
  const batch = pending;
  pending = {};
  flushing = fetchJSON('/preferences/ui', {
    method: 'PATCH',
    body: JSON.stringify(batch),
    keepalive: options.keepalive,
  })
    .then(() => undefined)
    .catch(() => {
      // Keep the batch, but let anything changed since win over it.
      pending = { ...batch, ...pending };
    })
    .finally(() => { flushing = null; });
  await flushing;
}

/**
 * Load the signed-in user's settings into localStorage, then start syncing. Resolves once the app can render with
 * them; a failed load resolves too (the browser's own copy is used and nothing is synced until the next sign-in or
 * reload, so a server we could not read is never overwritten with local values).
 */
export async function hydrateUiSettings(): Promise<void> {
  if (getAuthToken() === null) return;
  let server: Record<string, string>;
  try {
    server = await fetchJSON<Record<string, string>>('/preferences/ui');
  } catch {
    return;
  }
  const changed: string[] = [];
  for (const [key, value] of Object.entries(server)) {
    if (!isSyncedUiSetting(key)) continue; // a key this version no longer syncs: leave it on the server, ignore here
    if (readLocal(key) !== value) {
      writeLocal(key, value);
      changed.push(key);
    }
  }
  hydrated = true;

  // Synced keys only this browser has: this browser's settings from before syncing existed, or a choice made while
  // signed out. Send them up so the next browser gets them.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && isSyncedUiSetting(key) && !(key in server)) {
        const value = readLocal(key);
        if (value !== null) pending[key] = value;
      }
    }
  } catch { /* storage not enumerable: nothing local to send */ }
  void flushUiSettings();

  if (changed.includes(LANGUAGE_STORAGE_KEY)) {
    const lang = server[LANGUAGE_STORAGE_KEY];
    if (lang && lang !== i18n.language) void i18n.changeLanguage(lang);
  }
  if (changed.length > 0) {
    window.dispatchEvent(new CustomEvent(UI_SETTINGS_HYDRATED_EVENT, { detail: { changed } }));
  }
}

/** Stop syncing (sign-out, or a token the server rejected). Queued changes are dropped: they belong to that session. */
export function resetUiSettingsSync(): void {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  pending = {};
  hydrated = false;
}

let listenersInstalled = false;

/** Wire the global hooks once: language changes sync, a page hide sends what is queued, a cleared token stops syncing. */
export function installUiSettingsSync(): void {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  // i18next writes the language to localStorage itself (detection.caches); mirror it to the server.
  i18n.on('languageChanged', (lng) => { queue(LANGUAGE_STORAGE_KEY, lng); });
  window.addEventListener('pagehide', () => { void flushUiSettings({ keepalive: true }); });
  window.addEventListener('nebulis:auth-cleared', resetUiSettingsSync);
}

/** For tests only. */
export function __resetUiSettingsForTests(): void {
  resetUiSettingsSync();
  flushing = null;
}
