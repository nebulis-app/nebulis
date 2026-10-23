/**
 * Library — object "media" view.
 *
 * One flat, filterable list of everything an object has: processed images,
 * telescope images, sub-frames, videos and project archives, across every
 * night and every variant. Backs `GET /library/objects/:id/media` and the
 * web / native "All media" object page.
 *
 * Split in two on purpose:
 *  - `collectMediaItems` reads the existing per-variant sources
 *    (`getLocalFiles`, processed images, project archives), so the set of files
 *    shown (and what is hidden: Dwarf artifacts, thumbnails, stack previews)
 *    can never drift from what the observation page shows.
 *  - `buildObjectMedia` is pure: filter, facet, group, sort, page.
 */
import path from 'path';
import { getLocalFiles } from './observations.js';
import { getAllProcessedImagesForObject, type ProcessedImageRecord } from './processed.js';
import { getProjectArchivesForObject, type ProjectArchiveRecord } from './projectArchives.js';
import { getLibraryFilesForObject, sessionDateForRow } from './libraryFiles.js';
import { LIBRARY_API_BASE } from './objects.js';
import { getAllProfiles } from '../telescopes.js';

export const MEDIA_KINDS = ['processed', 'telescope', 'sub', 'project', 'video'] as const;
export const MEDIA_GROUP_BYS = ['night', 'telescope', 'filter', 'type', 'none'] as const;
export const MEDIA_SORTS = ['newest', 'oldest', 'time'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaGroupBy = (typeof MEDIA_GROUP_BYS)[number];
export type MediaSort = (typeof MEDIA_SORTS)[number];

export interface MediaTelescope {
  id: string;
  name: string;
  color: string;
}

export interface MediaItem {
  /** Stable across requests: the library path for files, the row id for
   *  processed images and project archives. */
  id: string;
  kind: MediaKind;
  /** The variant the item really lives under (delete / move act on this). */
  objectId: string;
  /** The row id, for processed images and project archives. */
  recordId?: string;
  name: string;
  title?: string;
  software?: string;
  /** Derived observing night (YYYY-MM-DD), null when the item belongs to none. */
  date: string | null;
  runDates?: string[] | null;
  telescope: MediaTelescope | null;
  exposure: string | null;
  filter: string | null;
  frameCount: number | null;
  /** Upper-case format label: JPEG, PNG, TIFF, FITS, MP4, ... */
  format: string;
  size: number;
  /** Sortable capture/upload time, or null. */
  capturedAt: string | null;
  isFavorite: boolean;
  previewable: boolean;
  /** Library path (folder/…), what /library/file and favorites key on. */
  path: string;
  thumbUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string;
  videoUrl?: string;
  /** A browser-renderable still (not FITS, not a download-only format). */
  isImage: boolean;
  isFits: boolean;
  /** Set on every item in a response: the `ObjectMedia.groups[].key` it sits under. */
  groupKey?: string;
  /** The source record, so a client can hand it straight to the existing
   *  viewers (which take a session file / processed image). Exactly one is set,
   *  matching `kind`. */
  file?: ReturnType<typeof getLocalFiles>[number];
  processed?: ProcessedImageRecord;
  project?: ProjectArchiveRecord;
}

export interface MediaQuery {
  kind: MediaKind | 'all';
  group: MediaGroupBy;
  sort: MediaSort;
  telescope?: string;
  filter?: string;
  night?: string;
  from?: string;
  to?: string;
  format?: string;
  favorites?: boolean;
  offset: number;
  limit: number;
  /** In the All tab, sub-frames are capped per group to this many. */
  subPreview: number;
}

export interface MediaGroup {
  key: string;
  /** Display text for dated / named groups; the tokens `across`, `projects`
   *  and `none` for the special groups, which clients translate. */
  label: string;
  /** Present when grouped by night. */
  date: string | null;
  telescope: MediaTelescope | null;
  /** Items in this group in the current filter (before the All-tab sub cap). */
  count: number;
  subCount: number;
  /** Sum of `frameCount` over sub-frames, or the sub count when frames are not
   *  counted individually. */
  frames: number;
  exposure: string | null;
  integrationSec: number | null;
  /** `across` and `projects` are pinned above the dated groups. */
  pinned: boolean;
}

export interface MediaFacets {
  telescopes: Array<MediaTelescope & { count: number }>;
  filters: Array<{ value: string; count: number }>;
  nights: Array<{ date: string; count: number }>;
  formats: Array<{ value: string; count: number }>;
}

export interface ObjectMedia {
  counts: Record<MediaKind | 'all', number>;
  facets: MediaFacets;
  groups: MediaGroup[];
  items: MediaItem[];
  total: number;
  nextOffset: number | null;
}

export const DEFAULT_MEDIA_QUERY: MediaQuery = {
  kind: 'all',
  group: 'night',
  sort: 'newest',
  offset: 0,
  limit: 120,
  subPreview: 6,
};

// ─── Collection ──────────────────────────────────────────────────────────────

const FORMAT_BY_EXT: Record<string, string> = {
  jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', tif: 'TIFF', tiff: 'TIFF',
  fit: 'FITS', fits: 'FITS', fts: 'FITS', mp4: 'MP4', mov: 'MOV', avi: 'AVI',
  xisf: 'XISF', psd: 'PSD', zip: 'ZIP', webp: 'WEBP',
};

export function formatLabel(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return FORMAT_BY_EXT[ext] ?? (ext ? ext.toUpperCase() : 'FILE');
}

function parseExposureSeconds(exposure: string | null): number | null {
  if (!exposure) return null;
  const m = exposure.match(/([\d.]+)\s*(ms|s)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return (m[2] ?? 's').toLowerCase() === 'ms' ? n / 1000 : n;
}

/**
 * Gather every media item for the given object ids (a base object plus its
 * variants). `favoritePaths` is the calling user's favorited image paths.
 */
export function collectMediaItems(objectIds: string[], favoritePaths: ReadonlySet<string>): MediaItem[] {
  const profiles = new Map(getAllProfiles().map(p => [p.id, { id: p.id, name: p.name, color: p.color }]));
  const items: MediaItem[] = [];

  for (const objectId of objectIds) {
    // Per-file attribution and observing night come from the libraryFiles rows;
    // `getLocalFiles` supplies the (already filtered) set of files to show.
    const rowByPath = new Map(getLibraryFilesForObject(objectId).map(r => [r.relPath, r]));

    for (const f of getLocalFiles(objectId)) {
      if (f.isThumbnail || f.fileType === 'thumbnail') continue;
      const isVideo = f.type === 'video';
      const isImage = f.type === 'image';
      const isFits = f.type === 'fits';
      if (!isVideo && !isImage && !isFits) continue;

      const row = rowByPath.get(f.path);
      let date = row ? sessionDateForRow(row) : null;
      // No row (or no recorded date): fall back to the date in the filename,
      // the same fallback getLocalFiles itself uses.
      if (!date && f.date) date = f.date;
      const kind: MediaKind = isVideo ? 'video' : f.fileType === 'sub' ? 'sub' : 'telescope';
      const telescope = row?.telescopeId ? profiles.get(row.telescopeId) ?? null : null;
      items.push({
        id: f.path,
        kind,
        objectId,
        name: f.name,
        date,
        telescope,
        exposure: f.exposure,
        filter: f.filter,
        frameCount: f.frameCount,
        format: formatLabel(f.name),
        size: f.size,
        capturedAt: f.timestamp || (row?.captureDate ? `${row.captureDate}${row.captureTime ?? ''}` : null),
        isFavorite: favoritePaths.has(f.path),
        previewable: f.previewable !== false,
        path: f.path,
        thumbUrl: f.thumbUrl ?? null,
        previewUrl: f.previewUrl ?? null,
        downloadUrl: f.downloadUrl,
        videoUrl: f.videoUrl,
        isImage,
        isFits,
        file: f,
      });
    }

    for (const p of getAllProcessedImagesForObject(objectId)) {
      const renderable = p.previewUrl !== null && p.thumbUrl === null;
      items.push({
        id: `processed:${p.id}`,
        kind: 'processed',
        objectId,
        recordId: p.id,
        name: p.originalName,
        title: p.title || undefined,
        date: p.date,
        runDates: p.runDates,
        telescope: null,
        exposure: null,
        filter: null,
        frameCount: null,
        format: formatLabel(p.originalName),
        size: p.size,
        capturedAt: p.uploadedAt,
        isFavorite: favoritePaths.has(p.path),
        previewable: p.previewUrl !== null,
        path: p.path,
        // A browser-renderable processed file has no separate thumb tier; give
        // grids the bounded server resize instead of the full-size original.
        thumbUrl: p.thumbUrl ?? (renderable
          ? `${LIBRARY_API_BASE}/file/thumbnail?path=${encodeURIComponent(p.path)}`
          : null),
        previewUrl: p.previewUrl,
        downloadUrl: p.url,
        isImage: renderable,
        isFits: p.thumbUrl !== null,
        processed: p,
      });
    }

    for (const a of getProjectArchivesForObject(objectId)) {
      items.push({
        id: `project:${a.id}`,
        kind: 'project',
        objectId,
        recordId: a.id,
        name: a.originalName,
        title: a.title || undefined,
        software: a.software || undefined,
        date: null,
        telescope: null,
        exposure: null,
        filter: null,
        frameCount: null,
        format: formatLabel(a.originalName),
        size: a.size,
        capturedAt: a.uploadedAt,
        isFavorite: false,
        previewable: false,
        path: a.path,
        thumbUrl: null,
        previewUrl: null,
        downloadUrl: a.url,
        isImage: false,
        isFits: false,
        project: a,
      });
    }
  }
  return items;
}

// ─── Building ────────────────────────────────────────────────────────────────

const KIND_ORDER: Record<MediaKind, number> = { processed: 0, telescope: 1, video: 2, project: 3, sub: 4 };

const GROUP_ACROSS = '_across';
const GROUP_PROJECTS = '_projects';
const GROUP_NONE = '_none';

function groupKeyFor(item: MediaItem, by: MediaGroupBy): string {
  if (item.kind === 'project') return GROUP_PROJECTS;
  switch (by) {
    case 'night':
      if (item.runDates && item.runDates.length > 1) return GROUP_ACROSS;
      return item.date ?? GROUP_NONE;
    case 'telescope': return item.telescope?.id ?? GROUP_NONE;
    case 'filter': return item.filter ?? GROUP_NONE;
    case 'type': return item.kind;
    case 'none': return 'all';
  }
}

function matchesFilters(item: MediaItem, q: MediaQuery): boolean {
  if (q.telescope && item.telescope?.id !== q.telescope) return false;
  if (q.filter && item.filter !== q.filter) return false;
  if (q.format && item.format !== q.format) return false;
  if (q.favorites && !item.isFavorite) return false;
  if (q.night && item.date !== q.night) return false;
  if (q.from && (!item.date || item.date < q.from)) return false;
  if (q.to && (!item.date || item.date > q.to)) return false;
  return true;
}

function bump<K>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function cmpTime(a: MediaItem, b: MediaItem): number {
  return (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.name.localeCompare(b.name);
}

export function buildObjectMedia(all: MediaItem[], q: MediaQuery): ObjectMedia {
  // Facets describe the tab being shown, ignoring every other filter, so an
  // option never disappears just because another one is active.
  const inTab = q.kind === 'all' ? all : all.filter(i => i.kind === q.kind);
  const telescopeCounts = new Map<string, MediaTelescope & { count: number }>();
  const filterCounts = new Map<string, number>();
  const nightCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();
  for (const i of inTab) {
    if (i.telescope) {
      const t = telescopeCounts.get(i.telescope.id);
      if (t) t.count += 1; else telescopeCounts.set(i.telescope.id, { ...i.telescope, count: 1 });
    }
    if (i.filter) bump(filterCounts, i.filter);
    if (i.date) bump(nightCounts, i.date);
    bump(formatCounts, i.format);
  }
  const facets: MediaFacets = {
    telescopes: [...telescopeCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    filters: [...filterCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    nights: [...nightCounts].map(([date, count]) => ({ date, count })).sort((a, b) => b.date.localeCompare(a.date)),
    formats: [...formatCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };

  const filtered = all.filter(i => matchesFilters(i, q));
  const counts: Record<MediaKind | 'all', number> = {
    all: filtered.length, processed: 0, telescope: 0, sub: 0, project: 0, video: 0,
  };
  for (const i of filtered) counts[i.kind] += 1;

  const shown = q.kind === 'all' ? filtered : filtered.filter(i => i.kind === q.kind);

  // Bucket, then order the buckets and each bucket's contents.
  const buckets = new Map<string, MediaItem[]>();
  for (const i of shown) {
    const key = groupKeyFor(i, q.group);
    const b = buckets.get(key);
    if (b) b.push(i); else buckets.set(key, [i]);
  }

  const dir = q.sort === 'oldest' ? 1 : -1;
  const groups: MediaGroup[] = [];
  const ordered: Array<{ key: string; items: MediaItem[] }> = [];

  const byDate = (a: string, b: string) => dir * a.localeCompare(b);
  const keys = [...buckets.keys()].sort((a, b) => {
    const pinA = a === GROUP_ACROSS ? 0 : a === GROUP_PROJECTS ? 1 : 2;
    const pinB = b === GROUP_ACROSS ? 0 : b === GROUP_PROJECTS ? 1 : 2;
    if (pinA !== pinB) return pinA - pinB;
    if (a === GROUP_NONE) return 1;
    if (b === GROUP_NONE) return -1;
    if (q.group === 'night') return byDate(a, b);
    if (q.group === 'type') {
      // Grouped by type, every key is the item's MediaKind (see groupKeyFor).
      const kindA = MEDIA_KINDS.find(k => k === a);
      const kindB = MEDIA_KINDS.find(k => k === b);
      if (kindA && kindB) return KIND_ORDER[kindA] - KIND_ORDER[kindB];
      return a.localeCompare(b);
    }
    // telescope / filter: biggest group first. Keys come from `buckets`, so both are present.
    return ((buckets.get(b)?.length ?? 0) - (buckets.get(a)?.length ?? 0)) || a.localeCompare(b);
  });

  const inGroupDir = q.sort === 'oldest' || q.sort === 'time' ? 1 : -1;
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket) continue; // unreachable: `keys` is built from `buckets`
    bucket.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || inGroupDir * cmpTime(a, b));

    const subs = bucket.filter(i => i.kind === 'sub');
    const frames = subs.reduce((n, i) => n + (i.frameCount ?? 1), 0);
    const expSet = new Set(subs.map(i => i.exposure).filter((e): e is string => !!e));
    const exposure = expSet.size === 1 ? [...expSet][0] : null;
    const integration = subs.reduce((n, i) => n + (parseExposureSeconds(i.exposure) ?? 0) * (i.frameCount ?? 1), 0);
    const first = bucket[0];
    groups.push({
      key,
      label: key === GROUP_ACROSS ? 'across'
        : key === GROUP_PROJECTS ? 'projects'
        : key === GROUP_NONE || key === 'all' ? 'none'
        : q.group === 'telescope' ? (first.telescope?.name ?? key)
        : key,
      date: q.group === 'night' && /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null,
      telescope: q.group === 'telescope' ? first.telescope : null,
      count: bucket.length,
      subCount: subs.length,
      frames,
      exposure,
      integrationSec: integration > 0 ? Math.round(integration) : null,
      pinned: key === GROUP_ACROSS || key === GROUP_PROJECTS,
    });

    // The All tab only previews sub-frames: a 2,000-frame night would bury the
    // pictures. The Sub-frames tab (kind=sub) is where they are browsed in full.
    if (q.kind === 'all') {
      let seenSubs = 0;
      ordered.push({
        key,
        items: bucket.filter(i => i.kind !== 'sub' || ++seenSubs <= q.subPreview),
      });
    } else {
      ordered.push({ key, items: bucket });
    }
  }

  const flat = ordered.flatMap(g => g.items.map(i => ({ ...i, groupKey: g.key })));
  const page = flat.slice(q.offset, q.offset + q.limit);
  const end = q.offset + page.length;

  return {
    counts,
    facets,
    groups,
    items: page,
    total: flat.length,
    nextOffset: end < flat.length ? end : null,
  };
}
