import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const fail = new Set<string>();

vi.mock('../../server/lib/library/objects.js', () => ({
  enrichObjectData: vi.fn(async (id: string) => {
    calls.push(`enrich:${id}`);
    if (fail.has('enrich')) throw new Error('boom');
  }),
}));
vi.mock('../../server/lib/library/observations.js', () => ({
  enqueueSessionWeatherBackfill: vi.fn((id: string) => { calls.push(`weather:${id}`); }),
}));
vi.mock('../../server/lib/library/galleryThumbnailWarm.js', () => ({
  warmObjectThumbnails: vi.fn(async (ids: Iterable<string>, onProgress?: (p: unknown) => void) => {
    calls.push(`gallery:${[...ids].join(',')}`);
    onProgress?.({ done: 1, total: 1 });
    if (fail.has('gallery')) throw new Error('boom');
  }),
}));
vi.mock('../../server/lib/library/sessionThumbnailPrewarm.js', () => ({
  prewarmSessionThumbnails: vi.fn(async (reason: string) => { calls.push(`session:${reason}`); }),
}));
vi.mock('../../server/lib/library/integration.js', () => ({
  warmSubFrameHeaders: vi.fn(async (ids?: Iterable<string>) => {
    calls.push(`headers:${ids ? [...ids].join(',') : 'ALL'}`);
    return { objects: 1, frames: 2 };
  }),
}));

import { runPostImport, waitUpTo } from '../../server/lib/library/postImport';

beforeEach(() => { calls.length = 0; fail.clear(); });

describe('runPostImport', () => {
  it('runs every stage in order for a targeted run', async () => {
    const h = runPostImport({ reason: 'telescope-import', touched: ['M31', 'M42'], withNewFiles: ['M31'] });
    await h.done;
    expect(calls).toEqual([
      'enrich:M31', 'weather:M31', 'enrich:M42', 'weather:M42',
      'gallery:M31',
      'session:telescope-import',
      'headers:M31',
    ]);
  });

  it('foreground resolves before the background stages run', async () => {
    const h = runPostImport({ reason: 'folder-import', touched: ['M31'] });
    await h.foreground;
    expect(calls).toContain('gallery:M31');
    expect(calls).not.toContain('session:folder-import');
    await h.done;
    expect(calls).toContain('session:folder-import');
  });

  it('defaults withNewFiles to touched', async () => {
    await runPostImport({ reason: 'linked-folder', touched: ['NGC7000'] }).done;
    expect(calls).toContain('gallery:NGC7000');
    expect(calls).toContain('headers:NGC7000');
  });

  it('touched objects with no new files only get enrichment and weather', async () => {
    await runPostImport({ reason: 'subframe-sync', touched: ['M31'], withNewFiles: [] }).done;
    expect(calls).toEqual(['enrich:M31', 'weather:M31']);
  });

  it('a library-wide sweep runs only the background stages, over everything', async () => {
    await runPostImport({ reason: 'boot' }).done;
    expect(calls).toEqual(['session:boot', 'headers:ALL']);
  });

  it('one failing stage never stops the others', async () => {
    fail.add('enrich');
    fail.add('gallery');
    await runPostImport({ reason: 'telescope-import', touched: ['M31'] }).done;
    expect(calls).toEqual(['enrich:M31', 'weather:M31', 'gallery:M31', 'session:telescope-import', 'headers:M31']);
  });

  it('passes gallery-thumbnail progress through to the caller', async () => {
    const progress: unknown[] = [];
    await runPostImport({ reason: 'telescope-import', touched: ['M31'], onThumbnailProgress: p => progress.push(p) }).foreground;
    expect(progress).toEqual([{ done: 1, total: 1 }]);
  });

  it('serializes the background stages of overlapping runs', async () => {
    const a = runPostImport({ reason: 'telescope-import', touched: ['A'] });
    const b = runPostImport({ reason: 'linked-rescan', touched: ['B'] });
    await Promise.all([a.done, b.done]);
    const bg = calls.filter(c => c.startsWith('session:') || c.startsWith('headers:'));
    expect(bg).toEqual(['session:telescope-import', 'headers:A', 'session:linked-rescan', 'headers:B']);
  });
});

describe('waitUpTo', () => {
  it('stops waiting after the cap and never rejects', async () => {
    await waitUpTo(new Promise(() => {}), 20);
    await waitUpTo(Promise.reject(new Error('x')), 1000);
  });
});
