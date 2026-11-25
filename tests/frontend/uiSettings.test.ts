// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setUiSetting, removeUiSetting, hydrateUiSettings, flushUiSettings, resetUiSettingsSync, isSyncedUiSetting,
  UI_SETTINGS_HYDRATED_EVENT, UI_SETTINGS_OWNER_KEY, __resetUiSettingsForTests,
} from '../../src/lib/uiSettings';
import { setAuthToken } from '../../src/lib/api/client';

type Call = { url: string; method: string; body: unknown };

let calls: Call[];
let serverSettings: Record<string, string>;
let failGet: boolean;
let failPatch: boolean;
let currentUser: string | null;

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  __resetUiSettingsForTests();
  calls = [];
  serverSettings = {};
  failGet = false;
  failPatch = false;
  currentUser = 'user-a';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/auth/me')) {
      if (currentUser === null) return new Response('{}', { status: 500 });
      return ok({ id: currentUser, username: currentUser, role: 'admin' });
    }
    if (method === 'GET') {
      if (failGet) return new Response('{}', { status: 500 });
      return ok(serverSettings);
    }
    if (failPatch) return new Response('{}', { status: 503 });
    for (const [k, v] of Object.entries(body as Record<string, string | null>)) {
      if (v === null) delete serverSettings[k];
      else serverSettings[k] = v;
    }
    return ok(serverSettings);
  }));
  setAuthToken('token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const patches = () => calls.filter(c => c.method === 'PATCH').map(c => c.body);

describe('which keys sync', () => {
  it('syncs listed and pattern keys, but not the token, the UI scale or unknown keys', () => {
    expect(isSyncedUiSetting('nebulis-theme')).toBe(true);
    expect(isSyncedUiSetting('nebulis-language')).toBe(true);
    expect(isSyncedUiSetting('nebulis-library-hero-collapsed')).toBe(true);
    expect(isSyncedUiSetting('nebulis_migration_seen_2026-11-01T10:00:00Z')).toBe(true);
    expect(isSyncedUiSetting('nebulis_auth_token')).toBe(false);
    expect(isSyncedUiSetting('nebulis-ui-scale')).toBe(false);
    expect(isSyncedUiSetting('something-else')).toBe(false);
  });
});

describe('before hydration', () => {
  it('writes locally and sends nothing', async () => {
    setUiSetting('nebulis-theme', 'space');
    await flushUiSettings();
    expect(localStorage.getItem('nebulis-theme')).toBe('space');
    expect(calls).toEqual([]);
  });
});

describe('hydrateUiSettings', () => {
  it('lets the server win, announces what changed, and uploads synced keys only this browser has', async () => {
    serverSettings = { 'nebulis-theme': 'night', 'catalogs.observableOnly': '1' };
    localStorage.setItem('nebulis-theme', 'dark');
    localStorage.setItem('nebulis-library-sort', 'name');
    localStorage.setItem('unsynced-key', 'x');
    const events: string[][] = [];
    const onHydrated = (e: Event) => events.push((e as CustomEvent<{ changed: string[] }>).detail.changed);
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated);

    await hydrateUiSettings();
    await flushUiSettings();
    window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated);

    expect(localStorage.getItem('nebulis-theme')).toBe('night');
    expect(localStorage.getItem('catalogs.observableOnly')).toBe('1');
    expect(events).toEqual([['nebulis-theme', 'catalogs.observableOnly']]);
    expect(patches()).toEqual([{ 'nebulis-library-sort': 'name' }]);
    expect(serverSettings).not.toHaveProperty('unsynced-key');
    expect(serverSettings).not.toHaveProperty('nebulis_auth_token');
  });

  it('ignores server keys this version does not sync', async () => {
    serverSettings = { 'old-removed-key': 'v' };
    await hydrateUiSettings();
    expect(localStorage.getItem('old-removed-key')).toBeNull();
  });

  it('does nothing without a token', async () => {
    localStorage.removeItem('nebulis_auth_token');
    await hydrateUiSettings();
    setUiSetting('nebulis-theme', 'light');
    await flushUiSettings();
    expect(calls).toEqual([]);
  });

  it('when the server cannot be read, keeps the local copy and never overwrites the server', async () => {
    failGet = true;
    localStorage.setItem('nebulis-library-sort', 'name');
    await hydrateUiSettings();
    setUiSetting('nebulis-theme', 'light');
    await flushUiSettings();
    expect(patches()).toEqual([]);
    expect(localStorage.getItem('nebulis-theme')).toBe('light');
  });
});

describe('a browser shared by several accounts', () => {
  it('records the user it hydrated for, in a key that is never synced', async () => {
    await hydrateUiSettings();
    expect(localStorage.getItem(UI_SETTINGS_OWNER_KEY)).toBe('user-a');
    expect(isSyncedUiSetting(UI_SETTINGS_OWNER_KEY)).toBe(false);
  });

  it('sends up local-only keys when the same user signs in again', async () => {
    localStorage.setItem(UI_SETTINGS_OWNER_KEY, 'user-a');
    localStorage.setItem('nebulis-library-sort', 'name');
    await hydrateUiSettings();
    await flushUiSettings();
    expect(patches()).toEqual([{ 'nebulis-library-sort': 'name' }]);
  });

  it("clears another user's settings instead of sending them up, and applies this user's own", async () => {
    localStorage.setItem(UI_SETTINGS_OWNER_KEY, 'user-a');
    localStorage.setItem('nebulis-theme', 'night');
    localStorage.setItem('nebulis-library-sort', 'name');
    localStorage.setItem('nebulis-library-hero-collapsed', '1');
    localStorage.setItem('nebulis-ui-scale', '1.2'); // per-device, never synced: kept
    currentUser = 'user-b';
    serverSettings = { 'nebulis-theme': 'light' };
    const events: string[][] = [];
    const onHydrated = (e: Event) => events.push((e as CustomEvent<{ changed: string[] }>).detail.changed);
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated);

    await hydrateUiSettings();
    await flushUiSettings();
    window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated);

    expect(patches()).toEqual([]);
    expect(localStorage.getItem('nebulis-theme')).toBe('light');
    expect(localStorage.getItem('nebulis-library-sort')).toBeNull();
    expect(localStorage.getItem('nebulis-library-hero-collapsed')).toBeNull();
    expect(localStorage.getItem('nebulis-ui-scale')).toBe('1.2');
    expect(localStorage.getItem(UI_SETTINGS_OWNER_KEY)).toBe('user-b');
    expect(events).toHaveLength(1);
    expect(new Set(events[0])).toEqual(new Set(['nebulis-theme', 'nebulis-library-sort', 'nebulis-library-hero-collapsed']));
  });

  it('then syncs the new user normally', async () => {
    localStorage.setItem(UI_SETTINGS_OWNER_KEY, 'user-a');
    currentUser = 'user-b';
    await hydrateUiSettings();
    setUiSetting('nebulis-library-columns', '3');
    await flushUiSettings();
    expect(patches()).toEqual([{ 'nebulis-library-columns': '3' }]);
  });

  it('when the current user cannot be read, applies the server copy but sends and clears nothing', async () => {
    localStorage.setItem(UI_SETTINGS_OWNER_KEY, 'user-a');
    localStorage.setItem('nebulis-library-sort', 'name');
    currentUser = null;
    serverSettings = { 'nebulis-theme': 'space' };
    await hydrateUiSettings();
    await flushUiSettings();
    expect(patches()).toEqual([]);
    expect(localStorage.getItem('nebulis-theme')).toBe('space');
    expect(localStorage.getItem('nebulis-library-sort')).toBe('name');
    expect(localStorage.getItem(UI_SETTINGS_OWNER_KEY)).toBe('user-a');
  });
});

describe('after hydration', () => {
  beforeEach(async () => {
    await hydrateUiSettings();
    await flushUiSettings();
    calls = [];
  });

  it('groups changes into one PATCH, with null for a removal', async () => {
    setUiSetting('nebulis-theme', 'space');
    setUiSetting('nebulis-library-columns', '4');
    removeUiSetting('nebulis-library-hero-collapsed');
    await flushUiSettings();
    expect(patches()).toEqual([{ 'nebulis-theme': 'space', 'nebulis-library-columns': '4', 'nebulis-library-hero-collapsed': null }]);
  });

  it('sends nothing for an unchanged value or an unsynced key', async () => {
    setUiSetting('nebulis-theme', 'space');
    await flushUiSettings();
    calls = [];
    setUiSetting('nebulis-theme', 'space');
    setUiSetting('unsynced-key', 'x');
    await flushUiSettings();
    expect(patches()).toEqual([]);
    expect(localStorage.getItem('unsynced-key')).toBe('x');
  });

  it('keeps a failed batch and resends it with later changes winning', async () => {
    failPatch = true;
    setUiSetting('nebulis-theme', 'space');
    setUiSetting('nebulis-library-sort', 'name');
    await flushUiSettings();
    failPatch = false;
    setUiSetting('nebulis-theme', 'light');
    await flushUiSettings();
    expect(patches().at(-1)).toEqual({ 'nebulis-theme': 'light', 'nebulis-library-sort': 'name' });
    expect(serverSettings).toEqual({ 'nebulis-theme': 'light', 'nebulis-library-sort': 'name' });
  });

  it('stops syncing after a reset (sign-out or rejected token)', async () => {
    setUiSetting('nebulis-theme', 'space');
    resetUiSettingsSync();
    setUiSetting('nebulis-theme', 'light');
    await flushUiSettings();
    expect(patches()).toEqual([]);
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setUiSetting('nebulis-theme', 'night')).not.toThrow();
    vi.restoreAllMocks();
  });
});
