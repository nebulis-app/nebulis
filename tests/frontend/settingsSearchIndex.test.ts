import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_NAV } from '../../src/components/settings/settingsNavItems';
import { SETTINGS_SEARCH_INDEX } from '../../src/components/settings/settingsSearchIndex';

/**
 * The Settings search index is maintained by hand. A wrong pane id or a
 * renamed label key does not throw: the setting just stops turning up in
 * search. These checks fail instead.
 */

const LOCALES_DIR = path.join(__dirname, '..', '..', 'src', 'locales', 'en');

function readNamespace(ns: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${ns}.json`), 'utf-8'));
}

function resolves(tree: unknown, key: string): boolean {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

describe('settings search index', () => {
  it('points every entry at a real nav group and sub-item', () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const group = SETTINGS_NAV.find(g => g.id === entry.group);
      expect(group, `unknown group "${entry.group}" for ${entry.labelKey}`).toBeDefined();
      if (entry.section) {
        const ids = (group?.items ?? []).map(i => i.id);
        expect(ids, `unknown section "${entry.section}" for ${entry.labelKey}`).toContain(entry.section);
      }
    }
  });

  it('uses label keys that exist in the English locale', () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const ns = entry.ns ?? 'settings';
      expect(resolves(readNamespace(ns), entry.labelKey), `${ns}:${entry.labelKey} does not resolve`).toBe(true);
    }
  });

  it('lists every nav sub-item with at least one entry', () => {
    for (const group of SETTINGS_NAV) {
      for (const item of group.items ?? []) {
        const found = SETTINGS_SEARCH_INDEX.some(e => e.group === group.id && e.section === item.id);
        expect(found, `no search entry for ${group.id}/${item.id}`).toBe(true);
      }
    }
  });
});
