import { describe, it, expect } from 'vitest';
import {
  buildObjectMedia,
  formatLabel,
  DEFAULT_MEDIA_QUERY,
  type MediaItem,
  type MediaQuery,
} from '../../server/lib/library/objectMedia';

const SEESTAR = { id: 't1', name: 'SeeStar S50', color: '#f59e0b' };
const DWARF = { id: 't2', name: 'Dwarf 3', color: '#38bdf8' };

let n = 0;
function item(over: Partial<MediaItem>): MediaItem {
  n += 1;
  return {
    id: `item-${n}`,
    kind: 'telescope',
    objectId: 'M31',
    name: `file-${n}.jpg`,
    date: '2026-10-03',
    telescope: SEESTAR,
    exposure: '10s',
    filter: null,
    frameCount: null,
    format: 'JPEG',
    size: 1000,
    capturedAt: `20261003-0000${String(n).padStart(2, '0')}`,
    isFavorite: false,
    previewable: true,
    path: `M31/file-${n}.jpg`,
    thumbUrl: null,
    previewUrl: null,
    downloadUrl: '/x',
    isImage: true,
    isFits: false,
    ...over,
  };
}

const q = (over: Partial<MediaQuery> = {}): MediaQuery => ({ ...DEFAULT_MEDIA_QUERY, ...over });

function sample(): MediaItem[] {
  const subs = Array.from({ length: 20 }, () =>
    item({ kind: 'sub', format: 'FITS', isImage: false, isFits: true, date: '2026-10-03', filter: 'Ha', frameCount: 1 }));
  return [
    ...subs,
    item({ kind: 'telescope', date: '2026-10-03' }),
    item({ kind: 'telescope', date: '2026-09-28', telescope: DWARF }),
    item({ kind: 'processed', date: '2026-10-03', telescope: null, isFavorite: true }),
    item({ kind: 'processed', date: null, telescope: null, runDates: ['2026-09-28', '2026-10-03'] }),
    item({ kind: 'project', date: null, telescope: null, format: 'ZIP', isImage: false }),
    item({ kind: 'video', date: '2026-09-28', telescope: DWARF, format: 'MP4', isImage: false }),
  ];
}

describe('formatLabel', () => {
  it('maps known extensions and falls back to the upper-cased extension', () => {
    expect(formatLabel('a.jpg')).toBe('JPEG');
    expect(formatLabel('a.TIF')).toBe('TIFF');
    expect(formatLabel('a.fits')).toBe('FITS');
    expect(formatLabel('a.xyz')).toBe('XYZ');
    expect(formatLabel('noext')).toBe('FILE');
  });
});

describe('buildObjectMedia', () => {
  it('counts every kind, after filters, and sums to all', () => {
    const r = buildObjectMedia(sample(), q());
    expect(r.counts).toMatchObject({ all: 26, sub: 20, telescope: 2, processed: 2, project: 1, video: 1 });
  });

  it('caps sub-frames per group in the All tab but not in the Sub-frames tab', () => {
    const all = buildObjectMedia(sample(), q({ subPreview: 6 }));
    expect(all.items.filter(i => i.kind === 'sub')).toHaveLength(6);
    const night = all.groups.find(g => g.key === '2026-10-03')!;
    expect(night.subCount).toBe(20);
    expect(night.frames).toBe(20);

    const subs = buildObjectMedia(sample(), q({ kind: 'sub', subPreview: 6 }));
    expect(subs.items).toHaveLength(20);
  });

  it('orders pinned groups first, then nights newest first, and puts pictures before sub-frames', () => {
    const r = buildObjectMedia(sample(), q());
    expect(r.groups.map(g => g.key)).toEqual(['_across', '_projects', '2026-10-03', '2026-09-28']);
    const night = r.items.filter(i => i.groupKey === '2026-10-03').map(i => i.kind);
    expect(night.indexOf('sub')).toBeGreaterThan(night.lastIndexOf('telescope'));
    expect(night.indexOf('processed')).toBeLessThan(night.indexOf('telescope'));
  });

  it('reverses the night order for oldest-first', () => {
    const r = buildObjectMedia(sample(), q({ sort: 'oldest' }));
    expect(r.groups.map(g => g.key).slice(2)).toEqual(['2026-09-28', '2026-10-03']);
  });

  it('groups by telescope, with the unattributed group last', () => {
    const r = buildObjectMedia(sample(), q({ group: 'telescope' }));
    const keys = r.groups.map(g => g.key);
    expect(keys[0]).toBe('_projects');
    expect(keys[keys.length - 1]).toBe('_none');
    expect(r.groups.find(g => g.key === 't1')?.label).toBe('SeeStar S50');
  });

  it('filters by telescope and excludes items that carry no telescope', () => {
    const r = buildObjectMedia(sample(), q({ telescope: 't2' }));
    expect(r.counts.all).toBe(2);
    expect(r.items.every(i => i.telescope?.id === 't2')).toBe(true);
  });

  it('filters by night, date range, format and favorites', () => {
    expect(buildObjectMedia(sample(), q({ night: '2026-09-28' })).counts.all).toBe(2);
    expect(buildObjectMedia(sample(), q({ from: '2026-10-01' })).counts.all).toBe(22);
    expect(buildObjectMedia(sample(), q({ format: 'MP4' })).counts.all).toBe(1);
    expect(buildObjectMedia(sample(), q({ favorites: true })).counts.all).toBe(1);
  });

  it('computes facets from the tab, ignoring the other active filters', () => {
    const base = buildObjectMedia(sample(), q());
    const filtered = buildObjectMedia(sample(), q({ telescope: 't2' }));
    expect(filtered.facets.telescopes).toEqual(base.facets.telescopes);
    expect(base.facets.telescopes.map(t => [t.id, t.count])).toEqual([['t1', 21], ['t2', 2]]);
    expect(base.facets.filters).toEqual([{ value: 'Ha', count: 20 }]);
  });

  it('scopes facets to the selected tab', () => {
    const r = buildObjectMedia(sample(), q({ kind: 'video' }));
    expect(r.facets.telescopes.map(t => t.id)).toEqual(['t2']);
    expect(r.facets.formats).toEqual([{ value: 'MP4', count: 1 }]);
  });

  it('pages with a stable offset and reports the next one', () => {
    const first = buildObjectMedia(sample(), q({ limit: 5 }));
    expect(first.items).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    const second = buildObjectMedia(sample(), q({ limit: 5, offset: first.nextOffset! }));
    const ids = new Set([...first.items, ...second.items].map(i => i.id));
    expect(ids.size).toBe(10);
    const last = buildObjectMedia(sample(), q({ limit: 500 }));
    expect(last.nextOffset).toBeNull();
    expect(last.total).toBe(last.items.length);
  });

  it('returns an empty, well-formed result for an object with nothing', () => {
    const r = buildObjectMedia([], q());
    expect(r.items).toEqual([]);
    expect(r.groups).toEqual([]);
    expect(r.counts.all).toBe(0);
    expect(r.nextOffset).toBeNull();
  });

  it('keeps projects in their own group whatever the grouping', () => {
    for (const group of ['night', 'telescope', 'filter', 'type', 'none'] as const) {
      const r = buildObjectMedia(sample(), q({ group }));
      expect(r.items.find(i => i.kind === 'project')?.groupKey).toBe('_projects');
    }
  });
});
