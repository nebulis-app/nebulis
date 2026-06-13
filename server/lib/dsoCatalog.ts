/**
 * DSO catalog — loads the OpenNGC-derived catalog from server/data/openngc.json.
 * Provides search, filtering, and lookup for the ~3,200 Seestar-appropriate objects.
 */
// Inlined at bundle time by tsup/esbuild — no runtime file access needed.
import openNgcJson from '../data/openngc.json';

export interface DsoEntry {
  id: string;           // e.g. "M31", "NGC7000", "IC434"
  ngcName: string;      // raw name from OpenNGC, e.g. "NGC0224"
  name: string;         // display name, e.g. "Andromeda Galaxy"
  type: string;         // human label, e.g. "Spiral Galaxy"
  typeCode: string;     // OpenNGC type code, e.g. "G"
  constellation: string | null;
  ra: number;           // decimal hours
  dec: number;          // decimal degrees
  magnitude: number | null;
  majorAxisArcmin: number | null;
  commonNames: string[];
  messier: number | null;
}

let _catalog: DsoEntry[] | null = null;

/**
 * Runtime validator for an OpenNGC catalog entry. Keeps us honest about what
 * the bundled JSON actually contains — so a stale/corrupt catalog file throws
 * at module load instead of producing mysterious undefined-access crashes later.
 */
function isDsoEntry(value: unknown): value is DsoEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.ngcName === 'string' &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    typeof v.typeCode === 'string' &&
    (v.constellation === null || typeof v.constellation === 'string') &&
    typeof v.ra === 'number' &&
    typeof v.dec === 'number' &&
    (v.magnitude === null || typeof v.magnitude === 'number') &&
    (v.majorAxisArcmin === null || typeof v.majorAxisArcmin === 'number') &&
    Array.isArray(v.commonNames) && v.commonNames.every(n => typeof n === 'string') &&
    (v.messier === null || typeof v.messier === 'number')
  );
}

function parseDsoCatalog(data: unknown): DsoEntry[] {
  if (!Array.isArray(data)) {
    throw new Error('[dsoCatalog] openngc.json: expected top-level array');
  }
  // Validate shape — throw early with a pointed message if the bundle is bad.
  // Only check the first entry for performance; the bundled JSON is authored
  // by a script in this repo, so a shape mismatch is a build-time regression.
  if (data.length > 0 && !isDsoEntry(data[0])) {
    throw new Error('[dsoCatalog] openngc.json: entry shape does not match DsoEntry');
  }
  // Trust boundary — shape validated above by isDsoEntry. No `as unknown as T`.
  return data as DsoEntry[];
}

function loadCatalog(): DsoEntry[] {
  if (_catalog) return _catalog;
  _catalog = parseDsoCatalog(openNgcJson);
  return _catalog;
}

export function getCatalog(): DsoEntry[] {
  return loadCatalog();
}

export function getById(id: string): DsoEntry | undefined {
  const normalized = id.toUpperCase().replace(/\s+/g, '');
  return loadCatalog().find(e =>
    e.id.toUpperCase() === normalized ||
    e.ngcName.toUpperCase().replace(/\s+/g, '') === normalized
  );
}

export function search(query: string, limit = 30): DsoEntry[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();
  const catalog = loadCatalog();

  const results: Array<{ entry: DsoEntry; score: number }> = [];

  for (const entry of catalog) {
    let score = 0;
    const idLower = entry.id.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    const ngcLower = entry.ngcName.toLowerCase().replace(/^0+/, ''); // strip leading zeros

    if (idLower === q || nameLower === q) score = 100;
    else if (idLower.startsWith(q) || nameLower.startsWith(q)) score = 80;
    else if (ngcLower.startsWith(q.replace(/^ngc\s*/i, 'ngc'))) score = 75;
    else if (entry.commonNames.some(n => n.toLowerCase().startsWith(q))) score = 70;
    else if (nameLower.includes(q)) score = 50;
    else if (idLower.includes(q)) score = 40;
    else if (entry.commonNames.some(n => n.toLowerCase().includes(q))) score = 30;
    else if ((entry.constellation ?? '').toLowerCase().includes(q)) score = 20;

    if (score > 0) results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.entry);
}

export function filterCatalog(opts: {
  type?: string;
  constellation?: string;
  maxMag?: number;
  minSize?: number;
  limit?: number;
  offset?: number;
}): { entries: DsoEntry[]; total: number } {
  const catalog = loadCatalog();
  const filtered = catalog.filter(e => {
    if (opts.type && !e.type.toLowerCase().includes(opts.type.toLowerCase()) && e.typeCode !== opts.type) return false;
    if (opts.constellation && (e.constellation ?? '').toLowerCase() !== opts.constellation.toLowerCase()) return false;
    if (opts.maxMag != null && e.magnitude != null && e.magnitude > opts.maxMag) return false;
    if (opts.minSize != null && e.majorAxisArcmin != null && e.majorAxisArcmin < opts.minSize) return false;
    return true;
  });

  const total = filtered.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return { entries: filtered.slice(offset, offset + limit), total };
}
