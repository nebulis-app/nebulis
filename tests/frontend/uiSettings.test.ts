// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setUiSetting, removeUiSetting, hydrateUiSettings, flushUiSettings, resetUiSettingsSync, isSyncedUiSetting,
  UI_SETTINGS_HYDRATED_EVENT, __resetUiSettingsForTests,
} from '../../src/lib/uiSettings';
import { setAuthToken } from '../../src/lib/api/client';

type Call = { url: string; method: string; body: unknown };

let calls: Call[];
let serverSettings: Record<string, string>;
let failGet: boolean;
let failPatch: boolean;

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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
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
