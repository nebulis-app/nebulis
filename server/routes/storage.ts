import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../lib/logger.js';
import { cachedSmbListDir as smbListDir, BASE_PATH, isTelescopeOnline } from '../lib/smbCache.js';
import { isObjectFolder, isSubFolder, getObjectFromSubFolder, normalizeCatalogId, getFileCategory } from '../lib/telescopeFiles.js';
import { getCatalogEntry } from '../data/catalog.js';
import { DATA_DIR } from '../lib/paths.js';
import { getLibraryDir, isOnSameDeviceAsLibrary, describeLibraryLocation, getLibraryLocationInfo, isLibraryAvailable, isDefaultLocation, isNetworkLocation, isLibraryPinned, setLibraryPath, withTimeout, LIBRARY_IO_TIMEOUT_MS, LIBRARY_STATS_IO_TIMEOUT_MS } from '../lib/libraryPath.js';
import { isLibraryMigrating } from '../lib/libraryMaintenance.js';
import { acquireLibraryLock, isLibraryBusy, libraryBusyMessage, libraryBusyRefusal } from '../lib/libraryBusy.js';
import { listVolumes, listDirectories, normalizeUserPath } from '../lib/volumes.js';
import { locateFolderOnDisk, validateLocateInput, type LocateSample } from '../lib/folderLocate.js';
import { startMigration, getMigrationStatus } from '../lib/libraryMigration.js';
import { renestObject, renestLibrary, getRenestStatus, countFlatObjects } from '../lib/library/libraryRenest.js';
import { testNetworkLibraryConnection, NETWORK_MOUNT_DIR, type NetworkLibraryConfig } from '../lib/libraryNetwork.js';
import {
  ARCHIVE_NETWORK_MOUNT_DIR,
  ensureArchiveShareReady,
  networkArchiveSupported,
  networkDisplayPath,
  resolveNetworkArchiveRoot,
  testArchiveNetworkConnection,
  uncRootOf,
  type ShareAddress,
} from '../lib/archive/archiveNetwork.js';
import {
  connectArchiveDestination,
  DESTINATION_REJECTION_MESSAGE,
  ensureArchiveDestinationReady,
} from '../lib/archive/archiveDestination.js';
import { isOnSameDevice, isWithinRoot } from '../lib/archive/archivePath.js';
import { retireArchiveManifest } from '../lib/archive/archiveManifest.js';
import zlib from 'zlib';
import { requireAdmin } from '../middleware/auth.js';
import { strictRateLimiter } from '../middleware/rateLimit.js';
import { getLibraryObjectNames } from '../lib/localLibrary.js';
import { pickDefaultTarget } from '../lib/telescopes.js';
import { logEvent } from '../lib/systemLog.js';
import { isRecord } from '../lib/typeGuards.js';
import { createManualDatabaseBackup } from '../lib/db.js';
import { analyzeLibrary, fixStaleRecords, fixMissingObjects, fixLayoutDrift, fixMissingProcessed, fixDuplicateFiles, LibraryUnreadableError } from '../lib/library/analyze.js';
import { getSubframeUsage, purgeAllSubframes } from '../lib/library/cleanup.js';
import { getCurrentVersion } from '../lib/appUpdate/platform.js';
import os from 'os';
import { isSameMachineAddress } from '../lib/lanAddress.js';
import { resolveArchiveRoot } from '../lib/archive/archivePath.js';
import { newArchiveId, readArchiveMarker, writeArchiveMarker } from '../lib/archive/archiveMarker.js';
import {
  ArchiveConfigError,
  getArchiveConfig,
  getArchiveNetworkCredentials,
  setArchiveConfig,
  type ArchiveConfig,
  type ArchiveNetworkConfig,
  type ArchiveNetworkCredentials,
} from '../lib/archive/archiveConfig.js';
import { getArchiveRunProgress, isArchiveRunning } from '../lib/archive/archiveCopy.js';
import { cancelArchiveRun, clearLastArchiveRun, getLastArchiveRun, runArchivePipeline } from '../lib/archive/archivePipeline.js';
import { archiveBlockedByLibraryWork } from '../lib/archive/archiveScheduler.js';
import { applyArchiveRetention, planArchiveRetention } from '../lib/archive/archiveRetention.js';
import { listArchivedFiles, listArchivedObjects } from '../lib/archive/archiveBrowse.js';
import { restoreArchivedFiles } from '../lib/archive/archiveRestore.js';
import {
  BACKUPS_DIR,
  MAX_RETAINED,
  listDatabaseBackups,
  findDatabaseBackup,
  deleteDatabaseBackup,
  readLastAttempt,
} from '../lib/dbBackup.js';

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
  // unref: importing this router (e.g. in a test, or a script) must not keep
  // a process alive on a self-re-arming timer with no retained handle.
  setTimeout(async () => {
    await computeStorageStats().catch(() => {});
    scheduleStorageRefresh();
  }, delay).unref?.();
}
scheduleStorageRefresh();

// Kick off initial computation at startup (non-blocking)
setTimeout(() => computeStorageStats().catch(() => {}), 5_000).unref?.();

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
      { objects: cache.objects, telescopeOnline: isTelescopeOnline(target), telescopeKind: target?.kind ?? null },
      { summary: cache.summary, cached: true, cacheAge: Math.round(age / 1000), computing: cache.computing }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to calculate storage';
    res.apiError(500, 'STORAGE_FAILED', message);
  }
});

const execFileAsync = promisify(execFile);

// Decimal (SI, /1000) rather than binary (/1024): matches what Finder and
// Disk Utility report for disk capacity, so this figure lines up with what
// the user sees there for the same bytes. Keep in sync with the client copy
// in src/lib/utils.ts.
const SIZE_KB = 1000;
const SIZE_MB = SIZE_KB * 1000;
const SIZE_GB = SIZE_MB * 1000;

function formatBytes(bytes: number): string {
  if (bytes < SIZE_KB) return `${bytes} B`;
  if (bytes < SIZE_MB) return `${(bytes / SIZE_KB).toFixed(1)} KB`;
  if (bytes < SIZE_GB) return `${(bytes / SIZE_MB).toFixed(1)} MB`;
  return `${(bytes / SIZE_GB).toFixed(2)} GB`;
}

// ─── System storage ──────────────────────────────────────────────────

/**
 * macOS-only: total/free bytes for the APFS container holding `targetPath`,
 * read straight from `diskutil` instead of `statfs`. This is the number
 * Finder and Disk Utility show as "Available" — it counts purgeable space
 * (local Time Machine snapshots, other reclaimable-on-demand data) as free.
 * `statfs`'s `f_bavail` does NOT count purgeable space, so on a volume
 * carrying local snapshots it under-reports free space, sometimes by
 * hundreds of gigabytes, even though nothing is actually stopping that
 * space from being used. Returns null on any failure (non-APFS volume,
 * `diskutil`/`df` missing, timeout) so the caller falls back to statfs.
 */
async function getMacApfsContainerStats(targetPath: string): Promise<{ total: number; free: number } | null> {
  if (process.platform !== 'darwin') return null;
  try {
    // diskutil only accepts a device id or a mount point, not an arbitrary
    // subdirectory ("Could not find disk: ..."), so resolve the mount point
    // that actually owns targetPath first.
    const { stdout: dfOut } = await withTimeout(
      execFileAsync('df', ['-P', targetPath]),
      LIBRARY_IO_TIMEOUT_MS,
    );
    const lastLine = dfOut.trim().split('\n').pop();
    const mountPoint = lastLine?.trim().split(/\s+/).pop();
    if (!mountPoint) return null;

    const { stdout: plistOut } = await withTimeout(
      execFileAsync('diskutil', ['info', '-plist', mountPoint]),
      LIBRARY_IO_TIMEOUT_MS,
    );
    // Regex over the plist XML rather than a full plist parser: these two
    // keys are always emitted as a flat <key>/<integer> pair, and a missing
    // match (non-APFS volume) is exactly the null-fallback case we want.
    const freeMatch = plistOut.match(/<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/);
    const totalMatch = plistOut.match(/<key>APFSContainerSize<\/key>\s*<integer>(\d+)<\/integer>/);
    if (!freeMatch || !totalMatch) return null;

    const free = Number(freeMatch[1]);
    const total = Number(totalMatch[1]);
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return { total, free };
  } catch {
    return null;
  }
}

/**
 * Disk usage for the volume holding `targetPath`, via fs.statfsSync (works on
 * macOS, Linux, and Windows; no shell), refined on macOS by
 * `getMacApfsContainerStats` above so purgeable space isn't counted as used.
 *
 * `used` is derived as total - free, NOT taken from a per-volume "used" figure.
 * On APFS (and any shared-container filesystem) a single volume's own block
 * count undercounts what the disk is actually using, so total/used/free would
 * not reconcile. total - free matches what Finder/Explorer report.
 */
// Async + timeout-bounded (fs.promises.statfs, not fs.statfsSync): targetPath
// may be a relocated library on a network share, and this is called on every
// GET /storage/system — i.e. every time Settings -> Storage is opened. A sync
// statfs against a stale SMB mount blocks the whole event loop for as long as
// the OS's SMB client takes to give up; see the isLibraryAvailable() incident
// writeup in libraryPath.ts.
async function getDiskStats(targetPath: string): Promise<{ total: number; used: number; free: number } | null> {
  try {
    const s = await withTimeout(fs.promises.statfs(targetPath), LIBRARY_IO_TIMEOUT_MS);
    const blockSize = Number(s.bsize);
    let total = Number(s.blocks) * blockSize;
    // bavail = blocks free to an unprivileged process. On macOS this excludes
    // purgeable space, which Finder/Disk Utility (and users) treat as free;
    // getMacApfsContainerStats supplies the corrected figure when available.
    let free = Number(s.bavail) * blockSize;

    const apfs = await getMacApfsContainerStats(targetPath);
    if (apfs) {
      total = apfs.total;
      free = apfs.free;
    }

    const used = Math.max(0, total - free);
    if (total <= 0) return null;
    return { total, used, free };
  } catch {
    return null;
  }
}

/**
 * Whether two paths live on different physical volumes, compared by device id
 * (st_dev). A relocated library that happens to sit on the same drive as
 * DATA_DIR would report identical disk figures, so the caller uses this to skip
 * a redundant second card. When either path can't be stat'd, assume different
 * so a relocated drive is shown rather than hidden. Async + timeout-bounded for
 * the same reason as getDiskStats() above — `b` is often a network-mounted
 * library path.
 */
async function onDifferentVolume(a: string, b: string): Promise<boolean> {
  try {
    const [statA, statB] = await Promise.all([
      withTimeout(fs.promises.stat(a), LIBRARY_IO_TIMEOUT_MS),
      withTimeout(fs.promises.stat(b), LIBRARY_IO_TIMEOUT_MS),
    ]);
    return statA.dev !== statB.dev;
  } catch {
    return true;
  }
}

/** Disk stats shaped for the API response, or null when unavailable. */
async function diskResponse(targetPath: string) {
  const disk = await getDiskStats(targetPath);
  if (!disk) return null;
  return {
    total:          disk.total,
    used:           disk.used,
    free:           disk.free,
    usedPercent:    disk.total > 0 ? Math.round(disk.used / disk.total * 100) : 0,
    totalFormatted: formatBytes(disk.total),
    usedFormatted:  formatBytes(disk.used),
    freeFormatted:  formatBytes(disk.free),
  };
}

/**
 * Directories under DATA_DIR that hold a mounted network share.
 *
 * Both are skipped by the sync walks below. A walk that descended into one would
 * recurse into a network share, blocking the event loop on every Settings load, and
 * would count the share's bytes as local data. A set rather than a comparison
 * because there are two of them now and the next one should not need a second edit
 * at each site.
 */
const NETWORK_MOUNT_DIRS = new Set([NETWORK_MOUNT_DIR, ARCHIVE_NETWORK_MOUNT_DIR]);

/** Recursively count files and total byte size under a directory. Sync — only
 *  used for DATA_DIR (a local disk). The mounted network shares under DATA_DIR are
 *  skipped; see NETWORK_MOUNT_DIRS. */
function dirStats(dir: string): { size: number; files: number } {
  let size = 0, files = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (NETWORK_MOUNT_DIRS.has(full)) continue;
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

/** Async, timeout-bounded twin of dirStats() for the library tree, which may
 *  live on a network share where a sync walk would block the whole event loop.
 *  Uses LIBRARY_STATS_IO_TIMEOUT_MS (not the shorter interactive-request bound)
 *  because this only ever runs off the background cache refresh below, never a
 *  request handler directly. A file whose stat times out is dropped from BOTH
 *  size and files, not just size, so the two figures stay consistent with each
 *  other rather than fileCount silently outrunning size. */
async function dirStatsAsync(dir: string): Promise<{ size: number; files: number }> {
  let size = 0, files = 0;
  let entries: fs.Dirent[];
  try {
    entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), LIBRARY_STATS_IO_TIMEOUT_MS);
  } catch {
    return { size, files };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirStatsAsync(full);
      size += sub.size; files += sub.files;
    } else if (e.isFile()) {
      try {
        size += (await withTimeout(fs.promises.stat(full), LIBRARY_STATS_IO_TIMEOUT_MS)).size;
        files++;
      } catch { /* skip: dropped from both size and files together */ }
    }
  }
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
      if (NETWORK_MOUNT_DIRS.has(full)) continue;
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
router.get('/system', async (_req: Request, res: Response) => {
  // dataDirBreakdown already walks every top-level entry of DATA_DIR via
  // dirStats(); the total is their sum, so deriving it here avoids a second
  // full recursive stat of the tree (which can hold tens of thousands of
  // files between thumbnails/, sky-cache/, and backups/).
  const breakdown = dataDirBreakdown(DATA_DIR);
  const dataDir = breakdown.reduce(
    (acc, e) => ({ size: acc.size + e.size, files: acc.files + e.files }),
    { size: 0, files: 0 },
  );

  // When the library has been relocated to a separate drive, report that
  // drive's usage too. The DATA_DIR disk only covers the boot volume, so a
  // moved library's consumption would otherwise never show. Skipped when the
  // library is at its default location or on the same volume as DATA_DIR, where
  // it would just duplicate the local-server figures.
  const library = await getLibraryLocationInfo();
  const showLibraryDisk =
    !library.isDefault && library.available && await onDifferentVolume(DATA_DIR, library.path);
  const libraryDisk = showLibraryDisk ? await diskResponse(library.path) : null;

  res.apiSuccess({
    disk: await diskResponse(DATA_DIR),
    dataDir: {
      path:          DATA_DIR,
      size:          dataDir.size,
      files:         dataDir.files,
      sizeFormatted: formatBytes(dataDir.size),
      breakdown,
    },
    libraryDisk: libraryDisk ? { path: library.path, ...libraryDisk } : null,
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

async function computeLibraryStats(): Promise<void> {
  if (libraryCache.computing) return;
  // Skip while migrating or when the library (possibly a network share) isn't
  // reachable: a walk of a stale mount is pointless and the sync variant would
  // freeze the whole event loop. Keep the last-known cache rather than wiping
  // it to empty on a transient disconnect.
  if (isLibraryMigrating() || !(await isLibraryAvailable())) return;
  libraryCache.computing = true;

  const LIBRARY_DIR = getLibraryDir();
  try {
    // Pull display names from DB (non-deleted objects)
    const rows = getLibraryObjectNames();

    const nameMap = new Map(rows.map(r => [r.folderName, { objectId: r.objectId, name: r.objectName || r.folderName }]));

    const results: LibraryObjectStat[] = [];

    let entries: fs.Dirent[] = [];
    try {
      entries = await withTimeout(fs.promises.readdir(LIBRARY_DIR, { withFileTypes: true }), LIBRARY_STATS_IO_TIMEOUT_MS);
    } catch { /* library dir missing or unresponsive */ }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const stats = await dirStatsAsync(path.join(LIBRARY_DIR, e.name));
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

// Kick off initial computation non-blocking. unref: same reasoning as
// scheduleStorageRefresh above — importing this router must not pin a
// process/test-worker's event loop open.
setTimeout(() => { void computeLibraryStats().catch(() => { /* best-effort */ }); }, 8_000).unref?.();
setInterval(() => { void computeLibraryStats().catch(() => { /* best-effort */ }); }, LIBRARY_CACHE_TTL).unref?.();

// GET /api/v1/storage/library
router.get('/library', (_req: Request, res: Response) => {
  const age = Date.now() - libraryCache.computedAt;
  const isStale = age > LIBRARY_CACHE_TTL || libraryCache.computedAt === 0;

  if (libraryCache.computedAt === 0 && !libraryCache.computing) {
    void computeLibraryStats().catch(() => { /* best-effort */ });
  } else if (isStale && !libraryCache.computing) {
    void computeLibraryStats().catch(() => { /* best-effort */ });
  }

  res.apiSuccess(
    { objects: libraryCache.objects },
    { cacheAge: Math.round(age / 1000), computing: libraryCache.computing },
  );
});

// ─── Library location & migration ────────────────────────────────────────────

// GET /api/v1/storage/volumes — mounted drives the user can store the library on
/**
 * Is the browser making this request running on the same computer as the
 * server? The import dialog uses it to stop asking people to tell "this
 * device" from "the server" when, for them, those are one machine.
 */
router.get('/client-locality', requireAdmin, (req: Request, res: Response) => {
  res.apiSuccess({
    sameMachine: isSameMachineAddress(req.socket.remoteAddress),
    serverName: os.hostname().replace(/\.local$/i, ''),
  });
});

router.get('/volumes', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.apiSuccess({ volumes: await listVolumes() });
  } catch (err: unknown) {
    res.apiError(500, 'VOLUMES_FAILED', err instanceof Error ? err.message : 'Failed to list volumes');
  }
});

/**
 * Turn a failed readdir into something the user can act on. The common Windows
 * cases (a mapped drive letter the service can't see, a UNC share the Local
 * System account can't authenticate to) otherwise surface as a bare "cannot
 * read that folder" with no hint at the cause or the fix.
 */
function browseErrorMessage(target: string, err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const onWindows = process.platform === 'win32';
  const looksUnc = target.startsWith('\\\\') || target.startsWith('//');
  const looksDriveLetter = /^[A-Za-z]:[\\/]/.test(target);

  if (onWindows && looksUnc && (code === 'EACCES' || code === 'EPERM')) {
    return `Nebulis reached ${target} but is not allowed to read it. The Nebulis service runs as the Windows "Local System" account, which cannot sign in to network shares. Run the Nebulis service as your own Windows user account, or connect the share under Settings, Storage.`;
  }
  if (onWindows && looksUnc && code === 'ENOENT') {
    return `Network path not found: ${target}. Check the server name and share name, and that the share is online.`;
  }
  if (onWindows && looksDriveLetter && code === 'ENOENT') {
    return `${target.slice(0, 2)} looks like a mapped drive letter. Those exist only inside your personal Windows sign-in session, and Nebulis runs as a background service that cannot see them. Use the share's full network path instead, for example \\\\server\\share\\folder.`;
  }
  if (code === 'ENOENT') return `Folder not found: ${target}`;
  if (code === 'EACCES' || code === 'EPERM') return `Nebulis does not have permission to read ${target}.`;
  if (code === 'ENOTDIR') return `That path is a file, not a folder: ${target}`;
  return err instanceof Error ? err.message : 'Cannot read that folder';
}

// GET /api/v1/storage/browse?path=/abs/path — subdirectories for the folder picker
router.get('/browse', requireAdmin, async (req: Request, res: Response) => {
  const target = normalizeUserPath(typeof req.query.path === 'string' ? req.query.path : '');
  if (!target || !path.isAbsolute(target)) {
    res.apiError(
      400,
      'INVALID_PATH',
      process.platform === 'win32'
        ? 'Provide a full path, like D:\\Astro or a network path like \\\\server\\share\\folder.'
        : 'Provide an absolute path to browse.',
    );
    return;
  }
  try {
    res.apiSuccess({ path: target, directories: await listDirectories(target) });
  } catch (err: unknown) {
    res.apiError(400, 'BROWSE_FAILED', browseErrorMessage(target, err));
  }
});

/**
 * Rebuild one drag-and-drop file sample from an untrusted array entry.
 * Returns null for anything that isn't `{ relativePath: string, size: number }`
 * so the caller drops it rather than handing a half-shaped object to the
 * on-disk folder matcher.
 */
function parseLocateSample(value: unknown): LocateSample | null {
  if (!isRecord(value)) return null;
  const { relativePath, size } = value;
  if (typeof relativePath !== 'string' || typeof size !== 'number') return null;
  return { relativePath, size };
}

// POST /api/v1/storage/locate-folder — given the name and a file sample of a
// folder dropped into the import modal, check whether that exact folder exists
// on this machine's disk so the import can read it in place instead of
// uploading. Best-effort: a miss returns { path: null }, never an error.
router.post('/locate-folder', requireAdmin, async (req: Request, res: Response) => {
  // `req.body` is whatever the client posted. `isRecord` narrows it for real,
  // and each sample is rebuilt field by field by parseLocateSample, so nothing
  // downstream depends on an asserted shape.
  const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
  const anchorName = typeof body.anchorName === 'string' ? body.anchorName : '';
  const rawSamples: unknown[] = Array.isArray(body.samples) ? body.samples : [];
  const samples: LocateSample[] = rawSamples.flatMap(entry => {
    const sample = parseLocateSample(entry);
    return sample ? [sample] : [];
  });

  if (!validateLocateInput(anchorName, samples)) {
    res.apiError(400, 'INVALID_LOCATE_INPUT', 'Provide a folder name and a non-empty file sample.');
    return;
  }
  const located = await locateFolderOnDisk(anchorName, samples);
  if (located) {
    log.info({ anchorName, located, sampleCount: samples.length }, 'Import folder located on server disk');
  }
  res.apiSuccess({ path: located });
});

// GET /api/v1/storage/library-location — where the library lives + migration state
router.get('/library-location', async (_req: Request, res: Response) => {
  res.apiSuccess({ location: await getLibraryLocationInfo(), migration: getMigrationStatus() });
});

/**
 * Build a share config out of a request body. Takes `unknown` rather than a
 * body-shaped interface so the caller never has to assert what Express handed
 * it: `req.body` is whatever the client sent (including a JSON array, a
 * string, or nothing at all), and every field here is already coerced
 * individually, so a non-object simply yields the all-empty config that the
 * host/share emptiness checks downstream already reject.
 */
function parseNetworkConfig(body: unknown): NetworkLibraryConfig {
  const b = isRecord(body) ? body : {};
  const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    host: trimmed(b.host),
    share: trimmed(b.share),
    domain: trimmed(b.domain),
    username: trimmed(b.username),
    // Not trimmed: leading/trailing whitespace can be part of a password.
    password: typeof b.password === 'string' ? b.password : '',
    subpath: trimmed(b.subpath),
  };
}

// POST /api/v1/storage/library-location/network/test — try connecting to a
// share with not-yet-saved credentials. Never persists anything.
router.post('/library-location/network/test', requireAdmin, async (req: Request, res: Response) => {
  const cfg = parseNetworkConfig(req.body);
  const result = await testNetworkLibraryConnection(cfg);
  res.apiSuccess(result);
});

// POST /api/v1/storage/library-location/reset — forget a configured/relocated
// library location WITHOUT copying any files. For when the old drive or path is
// gone for good (e.g. a database copied from another machine points at a path
// this install can't reach, so "Move back to default" refuses because the
// source is unreachable). Afterwards the library resolves to the default
// location; the user is expected to already have their image folders there, or
// to re-import.
router.post('/library-location/reset', requireAdmin, async (req: Request, res: Response) => {
  if (isLibraryPinned()) {
    res.apiError(400, 'LIBRARY_PINNED', 'The library location is set by the LIBRARY_DIR environment variable. There is nothing to reset.');
    return;
  }
  if (isLibraryMigrating()) {
    res.apiError(409, 'LIBRARY_BUSY', 'The library is being moved. Wait for that to finish first.');
    return;
  }
  // describeLibraryLocation(), not getLibraryDir(): this is purely for the
  // response/log message, and the location being described here is exactly
  // the one about to be abandoned — including a network share this platform
  // can't act on (Linux/Docker), which is precisely the "gone for good" case
  // this route exists to recover from. Both functions resolve through the same
  // never-throwing path builder today, so this is about intent rather than
  // behaviour: describing what is about to be cleared must never be able to
  // fail the reset itself.
  const previousPath = describeLibraryLocation();
  if (isDefaultLocation()) {
    res.apiSuccess({ ok: true, changed: false, path: previousPath, previousPath });
    return;
  }
  await setLibraryPath('');
  logEvent({
    category: 'storage',
    event: 'library_location_reset',
    level: 'warning',
    message: `Reset the library location to default without moving files (was "${previousPath}").`,
    userId: req.userId,
    username: req.username,
    ip: req.ip ?? req.socket.remoteAddress,
    metadata: { previousPath },
  });
  res.apiSuccess({ ok: true, changed: true, path: getLibraryDir(), previousPath });
});

// POST /api/v1/storage/migrate { targetPath } OR { network: {...} } — start moving the library
router.post('/migrate', requireAdmin, (req: Request, res: Response) => {
  if (isLibraryPinned()) {
    res.apiError(400, 'LIBRARY_PINNED', 'The library location is set by the LIBRARY_DIR environment variable. Change that to move the library.');
    return;
  }
  // req.body is client-controlled, so narrow it instead of asserting a shape.
  const body = isRecord(req.body) ? req.body : {};

  if (body.network) {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      res.apiError(400, 'UNSUPPORTED_PLATFORM', 'Network share library locations are not supported on this platform.');
      return;
    }
    const networkConfig = parseNetworkConfig(body.network);
    if (!networkConfig.host || !networkConfig.share) {
      res.apiError(400, 'INVALID_NETWORK_CONFIG', 'Enter a server address and share name.');
      return;
    }
    // macOS mounts every share at one fixed point, so it can't hold a source and
    // a target share at once. Refuse network→network there with a clear message
    // rather than letting it silently copy zero files. (run() guards this too.)
    if (process.platform === 'darwin' && isNetworkLocation()) {
      res.apiError(
        400,
        'NETWORK_TO_NETWORK_UNSUPPORTED',
        'Moving directly from one network share to another is not supported on macOS. Move the library to a local folder first, then to the new share.',
      );
      return;
    }
    try {
      const migration = startMigration('', networkConfig);
      logEvent({
        category: 'storage',
        event: 'library_migration_started',
        level: 'warning',
        message: `Started moving the library to network share "${networkConfig.host}/${networkConfig.share}".`,
        userId: req.userId,
        username: req.username,
        ip: req.ip ?? req.socket.remoteAddress,
        metadata: { target: 'network', host: networkConfig.host, share: networkConfig.share },
      });
      res.apiSuccess({ migration });
    } catch (err: unknown) {
      res.apiError(409, 'MIGRATION_FAILED', err instanceof Error ? err.message : 'Could not start migration');
    }
    return;
  }

  const targetPath = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
  if (!targetPath) {
    res.apiError(400, 'INVALID_PATH', 'Choose a folder to move the library to.');
    return;
  }
  try {
    const migration = startMigration(targetPath);
    logEvent({
      category: 'storage',
      event: 'library_migration_started',
      level: 'warning',
      message: `Started moving the library to "${targetPath}".`,
      userId: req.userId,
      username: req.username,
      ip: req.ip ?? req.socket.remoteAddress,
      metadata: { target: 'local', targetPath },
    });
    res.apiSuccess({ migration });
  } catch (err: unknown) {
    res.apiError(409, 'MIGRATION_FAILED', err instanceof Error ? err.message : 'Could not start migration');
  }
});

// GET /api/v1/storage/migrate/status — poll migration progress
router.get('/migrate/status', (_req: Request, res: Response) => {
  res.apiSuccess({ migration: getMigrationStatus() });
});

// ─── Re-nest (flat → per-session layout) ────────────────────────────────────
// A one-way migration, not a preference: supporting both shapes forever would
// mean maintaining two read paths across the whole library. New objects are
// created nested already; this converts the ones that predate that.

router.get('/renest/status', (_req: Request, res: Response) => {
  res.apiSuccess({ renest: getRenestStatus(), flatObjects: countFlatObjects() });
});

router.post('/renest', requireAdmin, async (req: Request, res: Response) => {
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library is not connected. Reconnect it and try again.');
    return;
  }
  if (isLibraryMigrating()) {
    res.apiError(409, 'LIBRARY_BUSY', 'The library is being moved. Wait for that to finish first.');
    return;
  }
  if (getRenestStatus().running) {
    res.apiError(409, 'RENEST_RUNNING', 'A reorganize is already running.');
    return;
  }
  if (isLibraryBusy()) {
    const refusal = libraryBusyRefusal('An import or sync is running. Wait for that to finish first.');
    res.apiError(409, refusal.code, refusal.message);
    return;
  }

  // Optional body: `{ objectId }` reorganizes one object, no body reorganizes
  // the whole library. Narrowed with isRecord + typeof, never asserted.
  const renestBody: Record<string, unknown> = isRecord(req.body) ? req.body : {};
  const objectId = typeof renestBody.objectId === 'string' ? renestBody.objectId : null;

  try {
    if (objectId) {
      const result = renestObject(objectId);
      if (result.error) {
        if (/running/i.test(result.error)) {
          res.apiError(409, 'IMPORT_RUNNING', result.error);
          return;
        }
        res.apiError(500, 'RENEST_FAILED', result.error);
        return;
      }
      res.apiSuccess({ result });
      return;
    }
    // Fire-and-forget: renestLibrary() now yields between objects specifically
    // so the client can track it via /renest/status polling (the UI already
    // has a progress bar for this). Awaiting it here would hold this request
    // open for the whole run and defeat that, same as import's routes.
    renestLibrary().catch(err => {
      console.error('[renest] library run failed:', err instanceof Error ? err.message : err);
    });
    res.apiSuccess({ started: true });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reorganize failed';
    if (/running/i.test(message)) {
      res.apiError(409, 'IMPORT_RUNNING', message);
      return;
    }
    res.apiError(500, 'RENEST_FAILED', message);
  }
});

// ─── Library cleanup ────────────────────────────────────────────────────────

// GET /api/v1/storage/cleanup — space held by removable extras (sub-frames).
router.get('/cleanup', requireAdmin, async (_req: Request, res: Response) => {
  // Unreachable library = every file looks missing, so refuse rather than mislead.
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'The library location is not reachable.');
    return;
  }
  res.apiSuccess({ subframes: await getSubframeUsage() });
});

// DELETE /api/v1/storage/cleanup/subframes — purge every managed sub-frame.
router.delete('/cleanup/subframes', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'The library location is not reachable.');
    return;
  }
  const releaseLock = acquireLibraryLock('purge');
  if (releaseLock === null) {
    const refusal = libraryBusyRefusal('An import is running. Wait for it to finish, then purge.');
    res.apiError(409, refusal.code, refusal.message);
    return;
  }
  try {
    const result = await purgeAllSubframes();
    logEvent({
      category: 'storage',
      event: 'subframes_purged',
      level: 'warning',
      message: `Purged all sub-frames: ${result.deleted} files, ${result.freedBytes} bytes freed, ${result.staleRemoved} stale records removed.`,
      userId: req.userId,
      username: req.username,
      ip: req.ip ?? req.socket.remoteAddress,
      metadata: { ...result },
    });
    res.apiSuccess(result);
  } catch (err) {
    console.error('[storage] subframe purge failed:', err instanceof Error ? err.message : err);
    res.apiError(500, 'PURGE_FAILED', err instanceof Error ? err.message : 'Could not purge sub-frames');
  } finally {
    releaseLock();
  }
});

// GET /api/v1/storage/analyze — read-only scan for records that no longer match disk.
router.get('/analyze', requireAdmin, async (_req: Request, res: Response) => {
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'The library location is not reachable.');
    return;
  }
  try {
    res.apiSuccess(await analyzeLibrary());
  } catch (err) {
    res.apiError(500, 'ANALYZE_FAILED', err instanceof Error ? err.message : 'Analysis failed');
  }
});

// POST /api/v1/storage/analyze/fix — repair one category the analysis reported.
router.post('/analyze/fix', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
  const category = body.category;
  if (category !== 'staleRecords' && category !== 'missingObjects' && category !== 'layoutDrift' && category !== 'missingProcessed' && category !== 'duplicateFiles') {
    res.apiError(400, 'BAD_CATEGORY', 'Unknown repair category.');
    return;
  }
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'The library location is not reachable.');
    return;
  }
  const releaseLock = acquireLibraryLock('repair');
  if (releaseLock === null) {
    const refusal = libraryBusyRefusal('An import is running. Wait for it to finish, then repair.');
    res.apiError(409, refusal.code, refusal.message);
    return;
  }
  try {
    const result =
      category === 'staleRecords' ? await fixStaleRecords()
      : category === 'missingObjects' ? await fixMissingObjects()
      : category === 'missingProcessed' ? await fixMissingProcessed()
      : category === 'duplicateFiles' ? await fixDuplicateFiles()
      : fixLayoutDrift();
    logEvent({
      category: 'storage',
      event: 'library_repair',
      level: 'warning',
      message: `Library repair "${category}" completed.`,
      userId: req.userId,
      username: req.username,
      ip: req.ip ?? req.socket.remoteAddress,
      metadata: { category, ...result },
    });
    res.apiSuccess({ category, ...result });
  } catch (err) {
    if (err instanceof LibraryUnreadableError) {
      // Some paths could not be checked, so "missing" cannot be told from "unreadable"
      // and repairing would risk dropping records for files that are still there.
      res.apiError(409, 'LIBRARY_UNREADABLE', err.message);
      return;
    }
    console.error('[storage] library repair failed:', err instanceof Error ? err.message : err);
    res.apiError(500, 'REPAIR_FAILED', err instanceof Error ? err.message : 'Repair failed');
  } finally {
    releaseLock();
  }
});

// ─── Database backups (pre-upgrade snapshots + manual) ──────────────────────
// The automatic snapshot is taken at boot, before migrations (see
// lib/dbBackup.ts). These routes let an admin see what's retained, make one on
// demand, download one to keep permanently, or delete one.

// GET /api/v1/storage/db-backups — list retained snapshots + last attempt.
router.get('/db-backups', requireAdmin, (_req: Request, res: Response) => {
  res.apiSuccess({
    backups: listDatabaseBackups(),
    lastAttempt: readLastAttempt(),
    dir: BACKUPS_DIR,
    maxRetainedPerKind: MAX_RETAINED,
    currentVersion: getCurrentVersion().version,
  });
});

// POST /api/v1/storage/db-backups — take a snapshot now.
router.post('/db-backups', requireAdmin, strictRateLimiter, (req: Request, res: Response) => {
  try {
    const { backup, pruned } = createManualDatabaseBackup();
    logEvent({
      category: 'storage',
      event: 'db_backup_manual',
      message: `Created a manual database backup: ${backup.name}.`,
      userId: req.userId,
      username: req.username,
      ip: req.ip ?? req.socket.remoteAddress,
      metadata: { backupName: backup.name, sizeBytes: backup.sizeBytes, pruned },
    });
    res.apiSuccess({ backup, pruned });
  } catch (err) {
    console.error('[storage] manual db backup failed:', err instanceof Error ? err.message : err);
    res.apiError(500, 'BACKUP_FAILED', err instanceof Error ? err.message : 'Could not create a backup');
  }
});

// GET /api/v1/storage/db-backups/:name/download — stream one, gzip on the fly.
router.get('/db-backups/:name/download', requireAdmin, (req: Request, res: Response) => {
  const found = findDatabaseBackup(String(req.params.name));
  if (!found) {
    res.apiError(404, 'NOT_FOUND', 'That backup does not exist.');
    return;
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${found.name}.gz"`);
  const readStream = fs.createReadStream(found.path);
  readStream.on('error', (err) => {
    console.error('[storage] db backup download error:', err.message);
    if (!res.headersSent) res.apiError(500, 'STREAM_ERROR', 'Failed to read the backup file');
  });
  readStream.pipe(zlib.createGzip()).pipe(res);
});

// DELETE /api/v1/storage/db-backups/:name
router.delete('/db-backups/:name', requireAdmin, (req: Request, res: Response) => {
  const name = String(req.params.name);
  const found = findDatabaseBackup(name);
  if (!found) {
    res.apiError(404, 'NOT_FOUND', 'That backup does not exist.');
    return;
  }
  if (!deleteDatabaseBackup(name)) {
    res.apiError(500, 'DELETE_FAILED', 'Could not delete the backup file.');
    return;
  }
  logEvent({
    category: 'storage',
    event: 'db_backup_deleted',
    level: 'warning',
    message: `Deleted database backup ${name}.`,
    userId: req.userId,
    username: req.username,
    ip: req.ip ?? req.socket.remoteAddress,
    metadata: { backupName: name },
  });
  res.apiSuccess({ deleted: true, name });
});

// ─── External archive ────────────────────────────────────────────────────────
//
// Configuring and adopting are deliberately separate actions, so that saving a
// preference can never create anything on a disk.
//
// `PUT /archive` validates a destination and stores it, and writes nothing at it.
// A destination that is, contains, or is contained by the library or DATA_DIR is
// refused rather than saved, because the retention pass deletes files under
// whatever root is configured and a destination overlapping the library would
// eventually prune it.
//
// `POST /archive/adopt` is the only thing that writes a marker, and therefore the
// only thing that claims a disk. An empty disk is adopted directly: there is
// nothing to destroy. A disk already carrying a marker is refused unless the
// caller echoes back the exact id the status endpoint reported, which is both an
// explicit confirmation of what is being taken over and a guard against the disk
// being swapped between the two requests.

/** Everything the settings page needs to describe the destination. `network` never
 *  carries a password: `getArchiveConfig` has no field for one, so this payload
 *  cannot leak it by accident. */
interface ArchiveDestinationView {
  state:
    | 'unconfigured'
    | 'invalid-path'
    | 'offline'
    | 'match'
    | 'absent'
    | 'foreign'
    | 'invalid'
    | 'unreadable';
  path: string;
  foundArchiveId: string | null;
  locationType: ArchiveConfig['locationType'];
  network: ArchiveNetworkConfig;
  /** False on Linux/Docker, where a share cannot be mounted in process. The picker
   *  hides the network tab there rather than offering something that cannot work. */
  networkSupported: boolean;
  /** The archive shares a disk with the library or the data folder, so it would not
   *  survive that disk failing. A warning only; local destinations only. */
  sameDiskAsLibrary: boolean;
}

/**
 * Where the destination stands right now. Reads only; never writes.
 *
 * Connects first where that applies, for the same reason the library location's status
 * route does: "not connected" is a state the user has to be able to see. An unmounted
 * share's directory under DATA_DIR is an ordinary empty folder, and reporting it as
 * `absent` would offer to adopt it, which is the accident this whole feature is
 * arranged to prevent.
 *
 * Always computes a fresh answer. Called directly by every route that just took, or
 * is about to take, a real action (saving the config, adopting a disk) so those
 * responses can never show a stale state. Also refreshes `destinationViewCache`
 * below as a side effect, so a save or an adopt is reflected on the very next
 * passive read instead of waiting out that cache's TTL.
 */
async function archiveDestinationState(config: ArchiveConfig): Promise<ArchiveDestinationView> {
  const base: Omit<ArchiveDestinationView, 'state'> = {
    path: config.path,
    foundArchiveId: null,
    locationType: config.locationType,
    network: config.network,
    networkSupported: networkArchiveSupported(),
    sameDiskAsLibrary: false,
  };

  const value = await (async (): Promise<ArchiveDestinationView> => {
    if (config.locationType === 'network') {
      // Shown as the share the user configured, not as the directory it is mounted at.
      const display = networkDisplayPath(config.network);
      const connected = await connectArchiveDestination(config);
      if (!connected.ok) return { ...base, state: 'offline', path: display };

      const marker = readArchiveMarker(connected.root, config.archiveId);
      const foundArchiveId = marker.state === 'match' || marker.state === 'foreign' ? marker.marker.archiveId : null;
      return { ...base, state: marker.state, path: display, foundArchiveId };
    }

    if (config.path === '') {
      return { ...base, state: 'unconfigured', path: '' };
    }

    const resolved = resolveArchiveRoot(config.path);
    if (!resolved.ok) {
      // Reachable if the database was edited by hand, or if a later release
      // tightens the rules. Reporting the disk's marker state here would be
      // misleading, so the path itself is reported as the problem.
      return { ...base, state: 'invalid-path', path: config.path };
    }

    const marker = readArchiveMarker(resolved.root, config.archiveId);
    const foundArchiveId = marker.state === 'match' || marker.state === 'foreign' ? marker.marker.archiveId : null;
    const sameDiskAsLibrary =
      isOnSameDeviceAsLibrary(resolved.root) || isOnSameDevice(resolved.root, DATA_DIR);
    return { ...base, state: marker.state, path: resolved.root, foundArchiveId, sameDiskAsLibrary };
  })();

  destinationViewCache = { key: destinationViewCacheKey(config), computedAt: Date.now(), value };
  return value;
}

/**
 * Cache for `archiveDestinationStateForView` below, a passive-read-only path.
 * `archiveDestinationState` (above) keeps it warm as a side effect of every real
 * check it does, so this only ever serves an answer that was genuinely computed,
 * never a guess.
 */
interface DestinationViewCacheEntry {
  key: string;
  computedAt: number;
  value: ArchiveDestinationView;
}
let destinationViewCache: DestinationViewCacheEntry | null = null;

// Long enough that opening or reloading Settings -> Storage -> Archive repeatedly
// does not repeat an expensive network mount attempt on every single page view: a
// share that fails to mount can take several seconds to time out doing so, and that
// used to run unconditionally on every GET. Short enough that reconnecting the
// actual share still shows up within one page navigation for anyone who leaves the
// tab open and comes back.
const DESTINATION_VIEW_TTL_MS = 20_000;

function destinationViewCacheKey(config: ArchiveConfig): string {
  return config.locationType === 'network'
    ? `network:${config.archiveId}:${config.network.host}:${config.network.share}:${config.network.domain}:${config.network.username}:${config.network.subpath}`
    : `local:${config.archiveId}:${config.path}`;
}

/** Test-only: clears the view cache so a test starts from a real, fresh check. */
export function invalidateArchiveDestinationView(): void {
  destinationViewCache = null;
}

/**
 * The destination's state for a passive read: opening or reloading the settings
 * page, not an action the user is waiting on. A local destination is answered by
 * `archiveDestinationState` directly, uncached: it is a plain `fs.stat`, cheap
 * enough that caching it would only risk staleness for no real benefit. A network
 * destination reuses a recent result instead, because answering accurately means
 * actually mounting the share, and a share that is not currently reachable can take
 * several seconds to fail to do that on every request.
 */
async function archiveDestinationStateForView(config: ArchiveConfig): Promise<ArchiveDestinationView> {
  if (config.locationType !== 'network') return archiveDestinationState(config);

  const cached = destinationViewCache;
  const key = destinationViewCacheKey(config);
  if (cached && cached.key === key && Date.now() - cached.computedAt < DESTINATION_VIEW_TTL_MS) {
    return cached.value;
  }
  return archiveDestinationState(config);
}

/**
 * Whether the feature's acting routes may run, answering the request itself when not.
 *
 * The master switch is a promise to the user: with it off, the section is inert and
 * nothing touches their disk. A scheduler tick that still ran, or a route that still
 * pruned, would make that promise false, so every route that writes to the disk or
 * deletes from the library comes through here. Reads do not: "what is on that disk"
 * and "can this share be reached" have to stay answerable while the feature is off.
 *
 * Usage: `if (!archiveIsEnabled(res)) return;`
 */
function archiveIsEnabled(res: Response): boolean {
  if (getArchiveConfig().enabled) return true;
  res.apiError(409, 'ARCHIVE_DISABLED', 'The archive is turned off, so nothing was written or deleted. Turn it on in Settings, on the Archive tab.');
  return false;
}

// GET /api/v1/storage/archive — configuration plus the destination's state.
// Read-only, like the other storage status routes, so it needs no admin. A
// passive read, so it goes through the view cache rather than
// archiveDestinationState directly: see archiveDestinationStateForView's comment.
router.get('/archive', async (_req: Request, res: Response) => {
  const config = getArchiveConfig();
  res.apiSuccess({ config, destination: await archiveDestinationStateForView(config) });
});

// PUT /api/v1/storage/archive — save configuration. Writes nothing to the disk.
router.put('/archive', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  if (!isRecord(req.body)) {
    res.apiError(400, 'ARCHIVE_INVALID_CONFIG', 'Expected an object of archive settings.');
    return;
  }

  const { path: rawPath, ...rest } = req.body;
  // `locationType` and `network` travel in `rest` and are validated by
  // setArchiveConfig, which requires a server and a share for a network destination
  // and refuses a subpath that could climb out of the share.
  // Safe to hand the remaining keys straight to setArchiveConfig: it rejects
  // unknown keys and type-checks every value, so nothing is trusted merely
  // because it arrived in a request body.
  const patch: Record<string, unknown> = { ...rest };

  if ('path' in req.body) {
    if (typeof rawPath !== 'string') {
      res.apiError(400, 'ARCHIVE_INVALID_CONFIG', 'path must be a string.');
      return;
    }
    if (rawPath.trim() === '') {
      // Explicitly clearing the destination is allowed; it stops archiving.
      patch.path = '';
    } else {
      const resolved = resolveArchiveRoot(rawPath);
      if (!resolved.ok) {
        res.apiError(
          400,
          'ARCHIVE_INVALID_DESTINATION',
          DESTINATION_REJECTION_MESSAGE[resolved.reason] ?? 'That destination cannot be used.',
        );
        return;
      }
      patch.path = resolved.root;
    }
  }

  try {
    // Validates everything before writing anything, so a patch rejected on its
    // last field cannot leave the earlier ones stored.
    setArchiveConfig(patch);
  } catch (err) {
    if (err instanceof ArchiveConfigError) {
      res.apiError(400, 'ARCHIVE_INVALID_CONFIG', err.message);
      return;
    }
    res.apiError(500, 'ARCHIVE_SAVE_FAILED', err instanceof Error ? err.message : 'Could not save the archive settings.');
    return;
  }

  const config = getArchiveConfig();
  res.apiSuccess({ config, destination: await archiveDestinationState(config) });
});

// POST /api/v1/storage/archive/adopt — claim a disk as this install's archive.
router.post('/archive/adopt', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  // Adopting writes a marker to the user's disk, which is a disk write the master
  // switch covers.
  if (!archiveIsEnabled(res)) return;
  const config = getArchiveConfig();
  if (config.locationType === 'local' && config.path === '') {
    res.apiError(400, 'ARCHIVE_NO_DESTINATION', 'Configure an archive destination first.');
    return;
  }

  // Connecting first is what stops this from ever adopting an unmounted share's
  // empty directory, and it is also where a local destination's containment rule is
  // applied: both go through the same resolver the write paths use.
  const connected = await connectArchiveDestination(config);
  if (!connected.ok) {
    // "The destination is wrong" and "the destination is fine but not here right now"
    // are different answers, and the code says which: a bad path or subpath is not
    // something plugging the disk in will fix.
    if (connected.reason && DESTINATION_REJECTION_MESSAGE[connected.reason]) {
      res.apiError(400, 'ARCHIVE_INVALID_DESTINATION', DESTINATION_REJECTION_MESSAGE[connected.reason]);
      return;
    }
    res.apiError(400, 'ARCHIVE_DESTINATION_UNUSABLE', connected.warning);
    return;
  }
  const root = connected.root;

  // The picker may name a folder that does not exist yet. Creating it belongs here
  // and not in the save route: adopting is already the explicit action that writes to
  // the disk, and saving must stay incapable of creating anything.
  if (isRecord(req.body) && req.body.createFolder === true) {
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      res.apiError(
        500,
        'ARCHIVE_ADOPT_FAILED',
        err instanceof Error ? err.message : 'Could not create the archive folder.',
      );
      return;
    }
  }

  const marker = readArchiveMarker(root, config.archiveId);

  if (marker.state === 'match') {
    // Already ours; adopting again is a no-op rather than a second identity.
    res.apiSuccess({ config, destination: await archiveDestinationState(config) });
    return;
  }

  if (marker.state === 'invalid' || marker.state === 'unreadable') {
    // Never overwrite a marker we cannot read. It may be a newer format or
    // another product's file, and it is the only record of what is on the disk.
    res.apiError(
      409,
      'ARCHIVE_MARKER_UNREADABLE',
      'The marker file on that disk cannot be read, so it will not be overwritten. Remove it by hand if you are sure.',
    );
    return;
  }

  if (marker.state === 'foreign') {
    const confirm = isRecord(req.body) ? req.body.confirmArchiveId : undefined;
    if (typeof confirm !== 'string' || confirm !== marker.marker.archiveId) {
      res.apiError(
        409,
        'ARCHIVE_FOREIGN_CONFIRMATION_REQUIRED',
        `That disk already holds an archive (${marker.marker.archiveId}). Confirm that id to take it over.`,
      );
      return;
    }
  }

  if (!fs.existsSync(root)) {
    res.apiError(400, 'ARCHIVE_DESTINATION_MISSING', 'That folder does not exist. Plug the disk in and try again.');
    return;
  }

  const archiveId = newArchiveId();
  try {
    writeArchiveMarker(root, archiveId);
  } catch (err) {
    res.apiError(
      500,
      'ARCHIVE_ADOPT_FAILED',
      err instanceof Error ? err.message : 'Could not write the archive marker.',
    );
    return;
  }
  // The record on a disk describes another install's history. Set it aside so this
  // install starts its own: the files stay, but nothing here can prune them.
  const previousRecordSetAside = retireArchiveManifest(root);
  setArchiveConfig({ archiveId });

  const replacedId = marker.state === 'foreign' ? marker.marker.archiveId : null;
  logEvent({
    category: 'storage',
    event: 'archive_adopted',
    // Taking over someone else's marker is worth a warning in the log: the
    // previous archive is now unreachable through this install.
    level: replacedId ? 'warning' : 'info',
    message: replacedId
      ? `Adopted ${root} as the archive destination, replacing marker ${replacedId}.`
      : `Adopted ${root} as the archive destination.`,
    userId: req.userId,
    username: req.username,
    ip: req.ip ?? req.socket.remoteAddress,
    metadata: { path: root, replacedArchiveId: replacedId, previousRecordSetAside },
  });

  const updated = getArchiveConfig();
  res.apiSuccess({ config: updated, destination: await archiveDestinationState(updated) });
});

// POST /api/v1/storage/archive/destination/test — try a share with credentials that
// are not saved yet, for the picker's Test connection button. Writes nothing.
//
// An empty or absent password falls back to the stored one, so testing a share the
// user has already configured does not require retyping the password it already has.
router.post('/archive/destination/test', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  const network = isRecord(req.body) ? req.body.network : undefined;
  if (!isRecord(network)) {
    res.apiError(400, 'ARCHIVE_INVALID_CONFIG', 'Expected a network object describing the share.');
    return;
  }

  const stored = getArchiveNetworkCredentials();
  const str = (key: string, fallback: string): string => {
    const value = network[key];
    return typeof value === 'string' ? value : fallback;
  };
  const typedPassword = typeof network.password === 'string' ? network.password : '';

  const result = await testArchiveNetworkConnection({
    host: str('host', ''),
    share: str('share', ''),
    domain: str('domain', ''),
    username: str('username', ''),
    subpath: str('subpath', ''),
    // An empty password means "use the stored one", which is what makes re-testing a
    // share you configured earlier possible without retyping it. `clearPassword` is the
    // client saying it means it, so the fallback is skipped and the test is honest
    // about the credential the user just asked to forget.
    password: network.clearPassword === true ? typedPassword : typedPassword || stored.password,
  });

  res.apiSuccess({ ok: result.ok, reason: result.reason ?? null });
});

/**
 * The directory a browse request may walk: the share's own root, and nothing else.
 *
 * On macOS that is the mount directory, on Windows the UNC root. The route exists so
 * the picker can offer the folders inside a share, so it deliberately cannot be used
 * to walk the machine's filesystem through an admin endpoint.
 */
function browsableShareRoot(network: ShareAddress): string {
  return process.platform === 'darwin' ? ARCHIVE_NETWORK_MOUNT_DIR : uncRootOf(network);
}

/**
 * POST /api/v1/storage/archive/destination/browse — the folders inside a share.
 *
 * A POST that only reads, because it takes credentials. The picker has to list the
 * folders of a share the user has typed but not saved yet, so the request may carry
 * the candidate `network` object; without it, the saved destination is browsed, which
 * is what the settings section does when it reopens the picker on a configured share.
 *
 * POST rather than GET for the same reason `POST /library-location/network/test` is:
 * a password must not travel in a URL, where it lands in logs and history.
 */
router.post('/archive/destination/browse', requireAdmin, async (req: Request, res: Response) => {
  const body = isRecord(req.body) ? req.body : {};
  const candidate = isRecord(body.network) ? body.network : null;
  const config = getArchiveConfig();

  let shareRoot: string;

  if (candidate === null) {
    if (config.locationType !== 'network') {
      res.apiError(400, 'ARCHIVE_NOT_NETWORK', 'The archive destination is not a network share.');
      return;
    }
    const connected = await connectArchiveDestination(config);
    if (!connected.ok) {
      res.apiError(503, 'ARCHIVE_DESTINATION_UNUSABLE', connected.warning);
      return;
    }
    shareRoot = browsableShareRoot(config.network);
  } else {
    // The picker's case: the share the user is describing, not the one that is saved.
    const stored = getArchiveNetworkCredentials();
    const str = (key: string, fallback: string): string => {
      const value = candidate[key];
      return typeof value === 'string' ? value : fallback;
    };
    const typedPassword = typeof candidate.password === 'string' ? candidate.password : '';
    const network: ArchiveNetworkCredentials = {
      host: str('host', ''),
      share: str('share', ''),
      domain: str('domain', ''),
      username: str('username', ''),
      subpath: str('subpath', ''),
      // `clearPassword` is the client saying it means no password, so the fallback to
      // the stored one is skipped.
      password: candidate.clearPassword === true ? typedPassword : typedPassword || stored.password,
    };

    const resolved = resolveNetworkArchiveRoot(network);
    if (!resolved.ok) {
      res.apiError(
        400,
        'ARCHIVE_INVALID_DESTINATION',
        DESTINATION_REJECTION_MESSAGE[resolved.reason] ?? 'That network destination cannot be used.',
      );
      return;
    }
    if (!(await ensureArchiveShareReady(network))) {
      res.apiError(503, 'ARCHIVE_DESTINATION_UNUSABLE', 'The archive share is not connected.');
      return;
    }
    shareRoot = browsableShareRoot(network);
  }

  const requestedPath = typeof body.path === 'string' && body.path.trim() !== '' ? body.path : shareRoot;
  // Containment before any listing: the request may name any directory, and the
  // answer must be no unless it is the share or inside it.
  if (requestedPath !== shareRoot && !isWithinRoot(shareRoot, requestedPath)) {
    res.apiError(400, 'ARCHIVE_PATH_OUTSIDE_SHARE', 'That folder is not inside the archive share.');
    return;
  }

  try {
    const directories = await listDirectories(requestedPath);
    // `root` is the share's own root, so the client can show a path relative to the
    // share rather than an absolute one, and can tell when it is already at the top.
    res.apiSuccess({ path: requestedPath, root: shareRoot, directories });
  } catch (err) {
    res.apiError(500, 'ARCHIVE_BROWSE_FAILED', err instanceof Error ? err.message : 'Could not read that folder.');
  }
});

// ─── External archive: actions ───────────────────────────────────────────────
//
// The engines for these live in server/lib/archive/*. This is the surface that
// invokes them, and it is where the guards have to hold, because these are the
// endpoints an operator actually calls.
//
// Authority follows the existing storage routes: reads are unguarded (the global
// apiAuth still requires a token) and everything that writes to a disk, deletes, or
// writes into the library is `requireAdmin` with `strictRateLimiter`.

/** A restore request is a list of items, not an unbounded payload. */
const MAX_RESTORE_ITEMS = 500;

/** 409 for an archive action that cannot start because other library work is running. */
function sendArchiveBusy(res: Response): void {
  res.apiError(
    409,
    'ARCHIVE_LIBRARY_BUSY',
    isLibraryMigrating()
      ? 'The library is being moved. Try again when it finishes.'
      : libraryBusyMessage(),
  );
}

// GET /api/v1/storage/archive/run/status — how a run is going, and how the last one ended.
// `lastRun` is what a background run leaves behind once it finishes, including a refusal
// that only shows itself after selection (a full disk), because the POST has already
// answered by then.
router.get('/archive/run/status', (_req: Request, res: Response) => {
  res.apiSuccess({ progress: getArchiveRunProgress(), running: isArchiveRunning(), lastRun: getLastArchiveRun() });
});

// POST /api/v1/storage/archive/run — archive now, without waiting for the schedule.
//
// Answers 202 as soon as the run has been accepted and carries on in the background. A
// run over a large library takes minutes to hours, far past what an HTTP request should
// be held open for, and the settings page already polls /archive/run/status. Every
// refusal that can be decided up front (disabled, busy, no or wrong destination) is
// still a synchronous 4xx; what only shows up later is reported through `lastRun`.
router.post('/archive/run', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  if (!archiveIsEnabled(res)) return;
  if (isArchiveRunning()) {
    res.apiError(409, 'ARCHIVE_ALREADY_RUNNING', 'An archive run is already in progress.');
    return;
  }
  if (archiveBlockedByLibraryWork()) {
    sendArchiveBusy(res);
    return;
  }
  // Reading a disconnected library selects nothing and would report a clean run over
  // zero files, which reads as success. Refuse instead, so "archived 0 files" always
  // means what it says.
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library is not connected. Reconnect it and try again.');
    return;
  }

  // Held for the whole run, so an import or scan cannot start halfway through it.
  const releaseLock = acquireLibraryLock('archive');
  if (releaseLock === null) {
    sendArchiveBusy(res);
    return;
  }

  const config = getArchiveConfig();
  let started = false;
  try {
    const readiness = await ensureArchiveDestinationReady(config);
    if (!readiness.ok) {
      if (readiness.kind === 'unconfigured') {
        res.apiError(409, 'ARCHIVE_NO_DESTINATION', 'Configure an archive destination first.');
      } else {
        res.apiError(409, 'ARCHIVE_DESTINATION_UNUSABLE', 'That disk is not this install\u2019s archive.');
      }
      return;
    }

    clearLastArchiveRun();
    const actor = { userId: req.userId, username: req.username, ip: req.ip ?? req.socket.remoteAddress };

    void runArchivePipeline(config, new Date(), 'manual')
      .then(result => {
        if (!result.ran) return;
        logEvent({
          category: 'storage',
          event: 'archive_run',
          level: result.failures.length > 0 ? 'warning' : 'info',
          message: `Archive run: ${result.copied} copied, ${result.skipped} already present, ${result.failures.length} failed${result.cancelled ? ' (cancelled)' : ''}.`,
          ...actor,
          metadata: { copied: result.copied, skipped: result.skipped, failures: result.failures.length, cancelled: result.cancelled },
        });
      })
      .catch(err => {
        console.error('[archive] manual run failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        releaseLock();
      });
    started = true;

    res.status(202);
    res.apiSuccess({ started: true });
  } finally {
    // Only a run that never started still holds the lock here; a started one
    // releases it itself when the pipeline finishes.
    if (!started) releaseLock();
  }
});

// POST /api/v1/storage/archive/run/cancel — stop the run in progress, however it started.
//
// Takes effect at the next file boundary. Files already copied stay on the disk and in
// the record; local removal and pruning are skipped for a cancelled run.
router.post('/archive/run/cancel', requireAdmin, strictRateLimiter, (_req: Request, res: Response) => {
  if (!isArchiveRunning() || !cancelArchiveRun()) {
    res.apiError(409, 'ARCHIVE_NOT_RUNNING', 'There is no archive run to cancel.');
    return;
  }
  res.status(202);
  res.apiSuccess({ cancelling: true });
});

// GET /api/v1/storage/archive/retention — what retention would remove. Read-only:
// this is the dry run, and it is the same code path the apply below uses.
router.get('/archive/retention', async (_req: Request, res: Response) => {
  res.apiSuccess({ plan: await planArchiveRetention(getArchiveConfig(), new Date()) });
});

// POST /api/v1/storage/archive/retention/apply — prune the archive.
router.post('/archive/retention/apply', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  // Deleting from the archive is the most destructive thing this feature does, so it
  // is behind the master switch as well as behind its own retention switch.
  if (!archiveIsEnabled(res)) return;
  const config = getArchiveConfig();
  if (!config.retentionEnabled) {
    res.apiError(
      409,
      'ARCHIVE_RETENTION_DISABLED',
      'Pruning is turned off, so nothing was deleted. Turn it on in the archive settings.',
    );
    return;
  }
  if (archiveBlockedByLibraryWork()) {
    sendArchiveBusy(res);
    return;
  }
  const releaseLock = acquireLibraryLock('retention');
  if (releaseLock === null) {
    sendArchiveBusy(res);
    return;
  }
  let plan: Awaited<ReturnType<typeof planArchiveRetention>>;
  let result: Awaited<ReturnType<typeof applyArchiveRetention>>;
  try {
    plan = await planArchiveRetention(config, new Date());
    result = await applyArchiveRetention(config, plan);
  } finally {
    releaseLock();
  }

  if (result.removed > 0 || result.failures.length > 0) {
    logEvent({
      category: 'storage',
      event: 'archive_retention',
      // Deleting from an archive is worth a warning in the log even when it is
      // exactly what the user configured.
      level: result.failures.length > 0 ? 'warning' : 'info',
      message: `Archive retention removed ${result.removed} files (${result.bytesRemoved} bytes).`,
      userId: req.userId,
      username: req.username,
      ip: req.ip ?? req.socket.remoteAddress,
      metadata: { removed: result.removed, bytesRemoved: result.bytesRemoved, failures: result.failures.length },
    });
  }

  res.apiSuccess({ ...result, plan: { mode: plan.mode, filesTotal: plan.filesTotal, warnings: plan.warnings } });
});

// GET /api/v1/storage/archive/contents[?folder=] — browse the archive.
router.get('/archive/contents', async (req: Request, res: Response) => {
  const config = getArchiveConfig();
  const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
  // A query parameter rather than a path segment: archive folder names are object
  // names, which routinely contain spaces.
  if (folder !== '') {
    res.apiSuccess({ ...(await listArchivedFiles(config, folder)) });
    return;
  }
  res.apiSuccess({ ...(await listArchivedObjects(config)) });
});

// POST /api/v1/storage/archive/restore — write archived files back into the library.
router.post('/archive/restore', requireAdmin, strictRateLimiter, async (req: Request, res: Response) => {
  // Restoring writes into the library, so it is a feature action like the others and
  // stops with the feature rather than writing while the section says it is off.
  if (!archiveIsEnabled(res)) return;
  const body = isRecord(req.body) ? req.body : {};
  const items = body.items;

  if (!Array.isArray(items)) {
    res.apiError(400, 'ARCHIVE_INVALID_REQUEST', 'Expected an "items" list of { folderName, relPath }.');
    return;
  }
  if (items.length > MAX_RESTORE_ITEMS) {
    res.apiError(400, 'ARCHIVE_INVALID_REQUEST', `At most ${MAX_RESTORE_ITEMS} items can be restored at once.`);
    return;
  }

  const requests: Array<{ folderName: string; relPath: string }> = [];
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.folderName !== 'string' ||
      item.folderName === '' ||
      typeof item.relPath !== 'string' ||
      item.relPath === ''
    ) {
      res.apiError(400, 'ARCHIVE_INVALID_REQUEST', 'Every item needs a folderName and a relPath.');
      return;
    }
    requests.push({ folderName: item.folderName, relPath: item.relPath });
  }

  // A restore writes files and library rows into the library, which makes it a fourth
  // library write path. Every other one checks both of these, and a new write path must not skip them: with the library relocated to a
  // disconnected drive, getLibraryDir() still returns the old mount point, so writing
  // there would put files somewhere the user cannot see and record rows for a library
  // that is not mounted; a restore during a migration would mutate the migration's own
  // source while it is being copied.
  if (archiveBlockedByLibraryWork()) {
    sendArchiveBusy(res);
    return;
  }
  if (!(await isLibraryAvailable())) {
    res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library is not connected. Reconnect it and try again.');
    return;
  }

  // Overwriting is off unless it is explicitly and literally true: this is the
  // confirmation that lets a restore replace a file the user may have edited.
  const releaseLock = acquireLibraryLock('restore');
  if (releaseLock === null) {
    sendArchiveBusy(res);
    return;
  }
  let result: Awaited<ReturnType<typeof restoreArchivedFiles>>;
  try {
    result = await restoreArchivedFiles(getArchiveConfig(), requests, { overwrite: body.overwrite === true });
  } finally {
    releaseLock();
  }

  logEvent({
    category: 'storage',
    event: 'archive_restore',
    level: result.conflicts.length > 0 || result.failures.length > 0 ? 'warning' : 'info',
    message: `Archive restore: ${result.restored} restored, ${result.skipped} already present, ${result.conflicts.length} conflicts.`,
    userId: req.userId,
    username: req.username,
    ip: req.ip ?? req.socket.remoteAddress,
    metadata: { restored: result.restored, conflicts: result.conflicts.length, failures: result.failures.length },
  });

  res.apiSuccess({ ...result });
});

export { router as storageRouter };
