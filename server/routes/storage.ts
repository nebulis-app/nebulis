import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { log } from '../lib/logger.js';
import { cachedSmbListDir as smbListDir, BASE_PATH, isTelescopeOnline } from '../lib/smbCache.js';
import { isObjectFolder, isSubFolder, getObjectFromSubFolder, normalizeCatalogId, getFileCategory } from '../lib/telescopeFiles.js';
import { getCatalogEntry } from '../data/catalog.js';
import { DATA_DIR } from '../lib/paths.js';
import { getLibraryDir, getLibraryLocationInfo } from '../lib/libraryPath.js';
import { listVolumes, listDirectories } from '../lib/volumes.js';
import { startMigration, getMigrationStatus } from '../lib/libraryMigration.js';
import { requireAdmin } from '../middleware/auth.js';
import db from '../lib/db.js';
import { pickDefaultTarget } from '../lib/telescopes.js';

const router = Router();

// ─── Background cache ───────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const REFRESH_INTERVAL = 5 * 60 * 1000; // refresh every 5 minutes

interface StorageObject {
  id: string;
  name: string;
  totalSize: number;
  fileCount: number;
  subFrameCount: number;
  subFrameSize: number;
  imageCount: number;
  fitsCount: number;
  oldestFile: string | null;
  newestFile: string | null;
}

interface StorageCache {
  objects: StorageObject[];
  summary: {
    totalSize: number;
    totalFiles: number;
    objectCount: number;
    byType: { images: number; fits: number; subFrames: number };
    formattedSize: string;
  };
  computedAt: number;
  computing: boolean;
}

const cache: StorageCache = {
  objects: [],
  summary: { totalSize: 0, totalFiles: 0, objectCount: 0, byType: { images: 0, fits: 0, subFrames: 0 }, formattedSize: '0 B' },
  computedAt: 0,
  computing: false,
};

let consecutiveSmbFailures = 0;

async function computeStorageStats(): Promise<void> {
  if (cache.computing) return;
  cache.computing = true;

  try {
    const target = pickDefaultTarget();
    if (!target) return;
    const entries = await smbListDir(BASE_PATH, target);
    const dirs = entries.filter(e => e.type === 'dir');
    const objectDirs = dirs.filter(d => isObjectFolder(d.name));
    const subDirs = dirs.filter(d => isSubFolder(d.name));

    const objectStats: StorageObject[] = [];
    let grandTotalSize = 0;
    let grandTotalFiles = 0;

    for (const dir of objectDirs) {
      const files = await smbListDir(`${BASE_PATH}/${dir.name}`, target);
      const fileList = files.filter(e => e.type === 'file');

      let totalSize = 0;
      let imageCount = 0;
      let fitsCount = 0;
      let oldest: string | null = null;
      let newest: string | null = null;

      for (const f of fileList) {
        totalSize += f.size || 0;
        const cat = getFileCategory(f.name);
        if (cat === 'image') imageCount++;
        if (cat === 'fits') fitsCount++;

        const dateMatch = f.name.match(/(\d{8}-\d{6})/);
        if (dateMatch) {
          if (!oldest || dateMatch[1] < oldest) oldest = dateMatch[1];
          if (!newest || dateMatch[1] > newest) newest = dateMatch[1];
        }
      }

      let subFrameCount = 0;
      let subFrameSize = 0;
      const subDir = subDirs.find(d => getObjectFromSubFolder(d.name) === dir.name);
      if (subDir) {
        try {
          const subFiles = await smbListDir(`${BASE_PATH}/${subDir.name}`, target);
          const subFileList = subFiles.filter(e => e.type === 'file');
          subFrameCount = subFileList.length;
          subFrameSize = subFileList.reduce((sum, f) => sum + (f.size || 0), 0);
        } catch {
          // ignore
        }
      }

      const normalized = normalizeCatalogId(dir.name);
      const catalog = getCatalogEntry(normalized) || getCatalogEntry(dir.name);

      const combinedSize = totalSize + subFrameSize;
      grandTotalSize += combinedSize;
      grandTotalFiles += fileList.length + subFrameCount;

      objectStats.push({
        id: dir.name,
        name: catalog?.name || dir.name,
        totalSize: combinedSize,
        fileCount: fileList.length,
        subFrameCount,
        subFrameSize,
        imageCount,
        fitsCount,
        oldestFile: oldest ? `${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}` : null,
        newestFile: newest ? `${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}` : null,
      });
    }

    objectStats.sort((a, b) => b.totalSize - a.totalSize);

    const byType = {
      images: objectStats.reduce((s, o) => s + o.imageCount, 0),
      fits: objectStats.reduce((s, o) => s + o.fitsCount, 0),
      subFrames: objectStats.reduce((s, o) => s + o.subFrameCount, 0),
    };

    cache.objects = objectStats;
    cache.summary = {
      totalSize: grandTotalSize,
      totalFiles: grandTotalFiles,
      objectCount: objectStats.length,
      byType,
      formattedSize: formatBytes(grandTotalSize),
    };
    cache.computedAt = Date.now();
  } catch (err) {
    consecutiveSmbFailures++;
    if (consecutiveSmbFailures === 1) {
      log.warn({ err }, 'storage_stats_refresh_failed');
    } else {
      log.debug({ err }, 'storage_stats_refresh_failed (telescope unreachable, suppressing repeats)');
    }
    return;
  } finally {
    cache.computing = false;
  }
  consecutiveSmbFailures = 0;
}

// Background refresh — backs off to 30 min when the telescope is unreachable
// so a 15-second SMB timeout doesn't fire every 5 minutes unnecessarily.
const REFRESH_INTERVAL_OFFLINE = 30 * 60 * 1000;
function scheduleStorageRefresh(): void {
  const delay = consecutiveSmbFailures > 0 ? REFRESH_INTERVAL_OFFLINE : REFRESH_INTERVAL;
  setTimeout(async () => {
    await computeStorageStats().catch(() => {});
    scheduleStorageRefresh();
  }, delay);
}
scheduleStorageRefresh();

// Kick off initial computation at startup (non-blocking)
setTimeout(() => computeStorageStats().catch(() => {}), 5_000);

// ─── Route ──────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  try {
    const age = Date.now() - cache.computedAt;
    const isStale = age > CACHE_TTL || cache.computedAt === 0;

    // If no data yet, compute on demand (first request before background finishes)
    if (cache.computedAt === 0 && !cache.computing) {
      await computeStorageStats();
    }

    // If stale, trigger background refresh (don't wait)
    if (isStale && !cache.computing) {
      computeStorageStats().catch(() => {});
    }

    const target = pickDefaultTarget();
    res.apiSuccess(
      { objects: cache.objects, telescopeOnline: isTelescopeOnline(), telescopeKind: target?.kind ?? null },
      { summary: cache.summary, cached: true, cacheAge: Math.round(age / 1000), computing: cache.computing }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to calculate storage';
    res.apiError(500, 'STORAGE_FAILED', message);
  }
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── System storage ──────────────────────────────────────────────────

/**
 * Disk usage for the volume holding `targetPath`, via fs.statfsSync (works on
 * macOS, Linux, and Windows; no shell).
 *
 * `used` is derived as total - free, NOT taken from a per-volume "used" figure.
 * On APFS (and any shared-container filesystem) a single volume's own block
 * count undercounts what the disk is actually using, so total/used/free would
 * not reconcile. total - free matches what Finder/Explorer report.
 */
function getDiskStats(targetPath: string): { total: number; used: number; free: number } | null {
  try {
    const s = fs.statfsSync(targetPath);
    const blockSize = Number(s.bsize);
    const total = Number(s.blocks) * blockSize;
    // bavail = blocks free to an unprivileged process (what's actually usable),
    // which is the figure Finder/Explorer treat as "free".
    const free = Number(s.bavail) * blockSize;
    const used = Math.max(0, total - free);
    if (total <= 0) return null;
    return { total, used, free };
  } catch {
    return null;
  }
}

/** Recursively count files and total byte size under a directory. */
function dirStats(dir: string): { size: number; files: number } {
  let size = 0, files = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = dirStats(full);
        size += sub.size; files += sub.files;
      } else if (e.isFile()) {
        try { size += fs.statSync(full).size; } catch { /* skip */ }
        files++;
      }
    }
  } catch { /* unreadable */ }
  return { size, files };
}

interface DataDirEntry {
  name: string;
  size: number;
  files: number;
  sizeFormatted: string;
}

/** Break down the top-level entries of DATA_DIR into per-item stats. */
function dataDirBreakdown(dir: string): DataDirEntry[] {
  const entries: DataDirEntry[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const s = dirStats(full);
        entries.push({ name: e.name, size: s.size, files: s.files, sizeFormatted: formatBytes(s.size) });
      } else if (e.isFile()) {
        try {
          const s = fs.statSync(full);
          entries.push({ name: e.name, size: s.size, files: 1, sizeFormatted: formatBytes(s.size) });
        } catch { /* skip */ }
      }
    }
  } catch { /* unreadable */ }
  entries.sort((a, b) => b.size - a.size);
  return entries;
}

// GET /api/v1/storage/system
router.get('/system', (_req: Request, res: Response) => {
  const disk      = getDiskStats(DATA_DIR);
  const dataDir   = dirStats(DATA_DIR);
  const breakdown = dataDirBreakdown(DATA_DIR);

  res.apiSuccess({
    disk: disk ? {
      total:          disk.total,
      used:           disk.used,
      free:           disk.free,
      usedPercent:    disk.total > 0 ? Math.round(disk.used / disk.total * 100) : 0,
      totalFormatted: formatBytes(disk.total),
      usedFormatted:  formatBytes(disk.used),
      freeFormatted:  formatBytes(disk.free),
    } : null,
    dataDir: {
      path:          DATA_DIR,
      size:          dataDir.size,
      files:         dataDir.files,
      sizeFormatted: formatBytes(dataDir.size),
      breakdown,
    },
  });
});

// ─── Library objects storage ─────────────────────────────────────────

interface LibraryObjectStat {
  objectId: string;
  name: string;
  size: number;
  sizeFormatted: string;
  fileCount: number;
}

interface LibraryStatsCache {
  objects: LibraryObjectStat[];
  computedAt: number;
  computing: boolean;
}

const libraryCache: LibraryStatsCache = { objects: [], computedAt: 0, computing: false };
const LIBRARY_CACHE_TTL = 5 * 60 * 1000;

function computeLibraryStats(): void {
  if (libraryCache.computing) return;
  libraryCache.computing = true;

  const LIBRARY_DIR = getLibraryDir();
  try {
    // Pull display names from DB (non-deleted objects)
    interface LibraryNameRow { objectId: string; folderName: string; objectName: string | null; }
    const rows = db
      .prepare<[], LibraryNameRow>('SELECT objectId, folderName, objectName FROM libraryObjects WHERE deleted = 0')
      .all();

    const nameMap = new Map(rows.map(r => [r.folderName, { objectId: r.objectId, name: r.objectName || r.folderName }]));

    const results: LibraryObjectStat[] = [];

    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true }); } catch { /* library dir missing */ }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const stats = dirStats(path.join(LIBRARY_DIR, e.name));
      const meta = nameMap.get(e.name);
      results.push({
        objectId: meta?.objectId ?? e.name,
        name: meta?.name ?? e.name,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        fileCount: stats.files,
      });
    }

    results.sort((a, b) => b.size - a.size);
    libraryCache.objects = results;
    libraryCache.computedAt = Date.now();
  } finally {
    libraryCache.computing = false;
  }
}

// Kick off initial computation non-blocking
setTimeout(() => { try { computeLibraryStats(); } catch { /* best-effort */ } }, 8_000);
setInterval(() => { try { computeLibraryStats(); } catch { /* best-effort */ } }, LIBRARY_CACHE_TTL);

// GET /api/v1/storage/library
router.get('/library', (_req: Request, res: Response) => {
  const age = Date.now() - libraryCache.computedAt;
  const isStale = age > LIBRARY_CACHE_TTL || libraryCache.computedAt === 0;

  if (libraryCache.computedAt === 0 && !libraryCache.computing) {
    computeLibraryStats();
  } else if (isStale && !libraryCache.computing) {
    computeLibraryStats();
  }

  res.apiSuccess(
    { objects: libraryCache.objects },
    { cacheAge: Math.round(age / 1000), computing: libraryCache.computing },
  );
});

// ─── Library location & migration ────────────────────────────────────────────

// GET /api/v1/storage/volumes — mounted drives the user can store the library on
router.get('/volumes', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.apiSuccess({ volumes: await listVolumes() });
  } catch (err: unknown) {
    res.apiError(500, 'VOLUMES_FAILED', err instanceof Error ? err.message : 'Failed to list volumes');
  }
});

// GET /api/v1/storage/browse?path=/abs/path — subdirectories for the folder picker
router.get('/browse', requireAdmin, async (req: Request, res: Response) => {
  const target = typeof req.query.path === 'string' ? req.query.path : '';
  if (!target || !path.isAbsolute(target)) {
    res.apiError(400, 'INVALID_PATH', 'Provide an absolute path to browse.');
    return;
  }
  try {
    res.apiSuccess({ path: target, directories: await listDirectories(target) });
  } catch (err: unknown) {
    res.apiError(400, 'BROWSE_FAILED', err instanceof Error ? err.message : 'Cannot read that folder');
  }
});

// GET /api/v1/storage/library-location — where the library lives + migration state
router.get('/library-location', (_req: Request, res: Response) => {
  res.apiSuccess({ location: getLibraryLocationInfo(), migration: getMigrationStatus() });
});

// POST /api/v1/storage/migrate { targetPath } — start moving the library
router.post('/migrate', requireAdmin, (req: Request, res: Response) => {
  const body = req.body as { targetPath?: unknown };
  const targetPath = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
  if (!targetPath) {
    res.apiError(400, 'INVALID_PATH', 'Choose a folder to move the library to.');
    return;
  }
  try {
    res.apiSuccess({ migration: startMigration(targetPath) });
  } catch (err: unknown) {
    res.apiError(409, 'MIGRATION_FAILED', err instanceof Error ? err.message : 'Could not start migration');
  }
});

// GET /api/v1/storage/migrate/status — poll migration progress
router.get('/migrate/status', (_req: Request, res: Response) => {
  res.apiSuccess({ migration: getMigrationStatus() });
});

export { router as storageRouter };
