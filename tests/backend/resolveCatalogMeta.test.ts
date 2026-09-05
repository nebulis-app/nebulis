import { describe, expect, it } from 'vitest';
import { resolveCatalogMeta } from '../../server/lib/library/objects';

describe('resolveCatalogMeta', () => {
  it('fills a curated description at import time from the catalog store', () => {
    // IC 342's curated text used to live only in curated-descriptions.json
    // under "C5", which the import path never read. It is now in the one
    // catalog store, and resolveCatalogMeta falls back to it. The library
    // grid, filter chips and the iOS/Android object screen all read the
    // column resolveCatalogMeta writes.
    const meta = resolveCatalogMeta('IC342');
    expect(meta.catalogId).toBe('IC342');
    expect(meta.description).toMatch(/IC ?342/);
  });

  it('still returns generic placeholders for an unrecognised id', () => {
    const meta = resolveCatalogMeta('NOT_A_REAL_OBJECT');
    expect(meta.objectType).toBe('Unknown');
    expect(meta.constellation).toBe('Unknown');
    expect(meta.description).toBe('');
  });
});
