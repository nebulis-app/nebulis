/**
 * Observing Catalog Progress API
 *
 * GET /api/v1/catalogs/:catalog/progress
 *   Returns all objects in a named observing catalog with imaged/remaining
 *   status from the user's library. Supports 'messier' initially; Caldwell
 *   and others plug in by adding an entry to CATALOG_CONFIGS below.
 */
import { Router, Request, Response } from 'express';
import { getLocalObjects } from '../lib/library/objects.js';
import { getCatalogEntry } from '../data/catalog.js';
import { prewarmThumbnails, findCachedMaster, startPrefetch, getPrefetchStatus } from '../lib/catalogPrefetch.js';
import { resolveCanonicalId } from '../lib/catalogAliases.js';
import { HERSCHEL400_IDS } from '../lib/herschel400Catalog.js';
import { SHARPLESS_CATALOG } from '../lib/sharplessCatalog.js';
import { raToHours, decToDegs } from '../lib/astroCalc.js';
import { computeBestImagingWindow, isUpTonight } from '../lib/bestImagingWindow.js';

const router = Router();

// ── Catalog definitions ──────────────────────────────────────────────────────

type CatalogDef = {
  label: string;
  /** Build the ordered list of catalog IDs for this observing program. */
  buildIds(): string[];
};

const CATALOG_CONFIGS: Record<string, CatalogDef> = {
  messier: {
    label: 'Messier',
    buildIds(): string[] {
      const ids: string[] = [];
      for (let n = 1; n <= 110; n++) ids.push(`M${n}`);
      return ids;
    },
  },
  caldwell: {
    label: 'Caldwell',
    buildIds(): string[] {
      const ids: string[] = [];
      for (let n = 1; n <= 109; n++) ids.push(`C${n}`);
      return ids;
    },
  },
  herschel400: {
    label: 'Herschel 400',
    buildIds(): string[] {
      return [...HERSCHEL400_IDS];
    },
  },
  sharpless: {
    label: 'Sharpless',
    buildIds(): string[] {
      // Sharpless catalog order is the Sh2-N numbering itself.
      return SHARPLESS_CATALOG.map(e => e.id);
    },
  },
};

// ── Type classification ──────────────────────────────────────────────────────

type ObjectClass = 'galaxy' | 'nebula' | 'cluster' | 'other';

function classifyType(type: string | undefined): ObjectClass {
  const t = (type ?? '').toLowerCase();
  if (t.includes('galaxy') || t.includes('gal') || t === 'g') return 'galaxy';
  if (
    t.includes('nebula') || t.includes('neb') || t.includes('planetary') ||
    t.includes('supernova') || t.includes('remnant') || t === 'pn' || t === 'snr'
  ) return 'nebula';
  if (
    t.includes('cluster') || t.includes('cl') || t.includes('asterism') ||
    t === 'oc' || t === 'gc' || t === 'ocl' || t === 'gcl'
  ) return 'cluster';
  return 'other';
}

// ── Library map helper ───────────────────────────────────────────────────────

function loadLibraryMap(): Map<string, { objectId: string; sessionCount: number }> {
  const map = new Map<string, { objectId: string; sessionCount: number }>();
  for (const o of getLocalObjects()) {
    const catId = typeof o.catalogId === 'string' ? o.catalogId : null;
    if (catId) {
      const key = catId.toUpperCase().replace(/\s+/g, '');
      const entry = { objectId: o.id, sessionCount: o.sessionCount };
      map.set(key, entry);
      // Also index under the canonical ID so catalog boards that iterate by
      // one designation (M82, C61) find library entries stored under another
      // (NGC3034, NGC4039) and vice-versa.
      const canonKey = resolveCanonicalId(key);
      if (canonKey !== key) map.set(canonKey, entry);
    }
  }
  return map;
}

// ── Route ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/catalogs/best-window?ra=&dec=&lat=&lon=&minAlt=
 *
 * The 12-month "best imaging window" the web client computes in-browser with
 * SunCalc, served for clients that have no sun-position math (iOS, Android).
 * `ra` is decimal hours, `dec`/`lat`/`lon` decimal degrees.
 */
router.get('/best-window', (req: Request, res: Response) => {
  const ra = Number(req.query.ra);
  const dec = Number(req.query.dec);
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const minAlt = req.query.minAlt != null ? Number(req.query.minAlt) : 20;

  if (![ra, dec, lat, lon, minAlt].every(Number.isFinite)) {
    res.apiError(400, 'BAD_REQUEST', 'ra, dec, lat and lon are required numbers');
    return;
  }

  const window = computeBestImagingWindow(ra, dec, lat, lon, minAlt);
  const upTonight = isUpTonight(ra, dec, lat, lon);

  res.apiSuccess({ ...window, upTonight });
});

router.get('/:catalog/progress', (req: Request, res: Response) => {
  const catalogKey = String(req.params.catalog).toLowerCase();
  const def = CATALOG_CONFIGS[catalogKey];
  if (!def) {
    res.apiError(404, 'UNKNOWN_CATALOG', `Catalog '${catalogKey}' is not supported`);
    return;
  }

  const ids = def.buildIds();
  const libraryMap = loadLibraryMap();

  type ByClass = { imaged: number; total: number };
  const byType: Record<ObjectClass, ByClass> = {
    galaxy:  { imaged: 0, total: 0 },
    nebula:  { imaged: 0, total: 0 },
    cluster: { imaged: 0, total: 0 },
    other:   { imaged: 0, total: 0 },
  };

  let imagedCount = 0;

  const objects = ids.map((rawId) => {
    const key = rawId.toUpperCase().replace(/\s+/g, '');
    const canonKey = resolveCanonicalId(key);

    // Sharpless entries carry no constellation or magnitude of their own, so
    // when an object cross-references a Messier/NGC/IC target, prefer that
    // richer entry and fall back to the bare Sharpless record otherwise.
    let entry = getCatalogEntry(key);
    if (catalogKey === 'sharpless' && canonKey !== key) {
      entry = getCatalogEntry(canonKey) ?? entry;
    }

    // Parse the catalog number from the ID string (M-number for Messier,
    // C-number for Caldwell, Sh2-N for Sharpless).
    const numMatch = rawId.match(/^(?:M|C|SH2-)(\d+)$/i);
    const catalogNum = numMatch ? parseInt(numMatch[1], 10) : null;

    const type = entry?.type ?? 'Unknown';
    const cls = classifyType(type);

    const libEntry = libraryMap.get(key) ?? libraryMap.get(canonKey);
    const isImaged = libEntry != null;

    byType[cls].total++;
    if (isImaged) {
      imagedCount++;
      byType[cls].imaged++;
    }

    // Resolve a user-friendly name: prefer the first common name, then the
    // catalog name, then fall back to the raw id.
    const commonName =
      (entry as { commonNames?: string[] } | undefined)?.commonNames?.[0] ??
      entry?.name ??
      rawId;

    return {
      number: catalogNum,
      id: rawId,
      ngcName: canonKey !== key ? canonKey : null,
      name: commonName,
      type,
      typeClass: cls,
      constellation: entry?.constellation ?? null,
      magnitude: entry?.magnitude ?? null,
      majorAxisArcmin:
        (entry as { majorAxisArcmin?: number | null } | undefined)?.majorAxisArcmin ?? null,
      // RA in decimal HOURS — the catalog board, object modal ("RA …h"),
      // best-imaging-window math, and plan-to-session flow all expect hours.
      // raToDegs would (inconsistently) return degrees for curated sexagesimal
      // entries while leaving decimal-hours strings untouched, which is what
      // stored degree-valued RA in plannedSessions for Messier objects.
      ra: entry?.ra != null ? raToHours(entry.ra) : null,
      dec: entry?.dec != null ? decToDegs(entry.dec) : null,
      isImaged,
      libraryObjectId: libEntry?.objectId ?? null,
      sessionCount: libEntry?.sessionCount ?? 0,
    };
  });

  res.apiSuccess({
    catalog: catalogKey,
    label: def.label,
    total: ids.length,
    imagedCount,
    byType,
    objects,
  });

  // Fire-and-forget: pre-warm thumbnails for objects that already have a
  // cached master, and — for Caldwell — trigger the image download phase if
  // most objects are still missing their master. The pack updater runs 60s
  // after startup, but users who visited the Caldwell board before that fires,
  // or whose pack download failed, would see blank tiles indefinitely.
  void (async () => {
    let mastersMissing = 0;
    for (const rawId of ids) {
      try {
        const canonId = resolveCanonicalId(rawId);
        const master = findCachedMaster(canonId, null);
        if (master) {
          await prewarmThumbnails(canonId, master.path, master.source);
        } else {
          mastersMissing++;
        }
      } catch { /* non-fatal */ }
    }

    // If more than half the catalog has no master and nothing is already
    // running, kick the appropriate prefetch phase so images appear without
    // the user having to manually start a prefetch from Settings.
    if (mastersMissing > ids.length / 2 && !getPrefetchStatus().running) {
      if (catalogKey === 'caldwell') {
        startPrefetch({ phase: 'caldwell' });
      } else {
        startPrefetch({ packsOnly: true });
      }
    }
  })();
});

export { router as catalogsRouter };
