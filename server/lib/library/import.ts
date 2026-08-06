/**
 * Library — import domain.
 *
 * Owns import state (running/cancel/progress) and every code path that pulls
 * files into the library: SMB fetch, local-folder copy, file-upload distribute,
 * and manual observation creation. Persists progress + history to SQLite via
 * the shared `stmts` from `./objects`.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getLibraryDir } from '../libraryPath.js';
import { THUMBNAILS_DIR } from '../paths.js';
import { generateFitsThumbnail } from '../fitsThumbnail.js';
import sharp from '../sharp-optional.js';
import db from '../db.js';
import {
  getProfileById,
  getManualImportProfiles,
  setProfileDeviceId,
  type TelescopeProfile,
} from '../telescopes.js';
import { smbListDir, smbGetFile, smbCopyFileTo, supportsStreamedCopy } from '../smb.js';
import { selectActiveTransport, markTransportSeen, type TransportKind } from '../telescopeTransports.js';
import { writeIdentityIfMissing } from '../deviceIdentity.js';
import {
  getWalkerConfig,
  buildObjectFilePath,
  isDwarfKind,
  discoverDwarfObjects,
  listDwarfObjectFiles,
  buildDwarfFilePath,
  extractDateFromSessionFolder,
  extractTargetFromSessionFolder,
  extractTimestampFromSessionFolder,
  isDwarfSessionFolder,
  type WalkerConfig,
} from '../walkers/index.js';
import {
  parseFilename,
  isObjectFolder,
  isSubFolder,
  getObjectFromSubFolder,
  normalizeObjectId,
  isRealFile,
  sessionNightFor,
  observingNightDate,
  clampToNightSafeTime,
} from '../telescopeFiles.js';
import { resolveCanonicalId, applyCatalogPreference } from '../catalogAliases.js';
import { getByName as getCatalogEntryByName } from '../dsoCatalog.js';
import { exifDateFromFile } from '../exifDate.js';
import {
  stmts,
  ensureLibraryDir,
  getFolderName,
  loadIndex,
  loadSettings,
  resolveCatalogMeta,
  enrichObjectData,
} from './objects.js';
import { resolveObjectImagePath, invalidateAllImagesCache } from './gallery.js';
import { recordLibraryFile, roleForFile, resolverFor, writeObjectManifest } from './libraryFiles.js';
import { isCaptureInfoSidecar, ingestCaptureInfoFile } from './captureInfo.js';
import {
  sessionFolderFor,
  layoutForImport,
  getObjectLayout,
  setObjectLayout,
  listObjectFiles,
  sanitizeSessionFolder,
  type LibraryLayout,
} from './libraryLayout.js';
import { backfillSessionWeather } from './observations.js';
import {
  classifyImportFile,
  isDwarfMasterStack,
  countSkip,
  summarizeSkips,
  SKIP_LABELS,
  type ImportSkipReason,
  type ImportSkipSummary,
  type SkipTally,
} from './importFilter.js';
import { isContainerFolder, groupByTarget } from './objectDiscovery.js';
import {
  collectObjectSources,
  walkObjectFiles,
  UNSORTED_KEY,
  type CommitPlan,
  type CommitObjectPlan,
  type ObjectSource,
  type WalkedFile,
} from './folderScan.js';
import {
  IMPORT_TMP_BASE,
  isStagedPath,
  checkFreeSpace,
  onSameVolume,
} from './importStaging.js';
import { deviceNoun, isGenericShare, offlineAdvice } from '../deviceWording.js';
import { canonicalImportName } from './importNaming.js';
import { debugLog } from '../debugLogger.js';
import { log } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImportStatus {
  running: boolean;
  /** Unique id minted when this run started. Lets a caller cancel exactly
   *  the run it started (see cancelImport) instead of whatever import
   *  happens to be active — e.g. the sub-frame sync modal closing must not
   *  kill an unrelated auto-import that raced in and claimed the lock. Null
   *  when no import has ever run in this process. */
  runId: string | null;
  currentObject: string | null;
  /** Telescope driving the current import run. Null for folder imports and
   *  drag-and-drop uploads, since those have no telescope context. */
  telescopeId: string | null;
  /** Human-readable name of the telescope (e.g. "Dwarf II", "Living-room
   *  SeeStar"). Lets the UI say "Importing M31 from Dwarf II" without
   *  another round-trip. Null when telescopeId is null. */
  telescopeName: string | null;
  /** Which transport this run is using. Drives the "via Wi-Fi" / "via USB"
   *  hint in the import progress UI so users with both transports
   *  configured can see which one the auto-import is actually pulling
   *  from. Null for non-telescope imports. */
  transportKind: TransportKind | null;
  objectsTotal: number;
  objectsDone: number;
  filesTotal: number;
  filesDone: number;
  currentObjectFilesTotal: number;
  currentObjectFilesDone: number;
  bytesTotal: number;
  bytesDone: number;
  skippedFiles: number;
  /** Files this run found on the telescope but will not import, grouped by
   *  why, largest group first. Distinct from `skippedFiles`, which counts
   *  files that were already present locally.
   *
   *  Without this the only signal is a file count lower than what is on the
   *  device, which reads as the import losing files rather than as a filter
   *  doing its job. The folder-import wizard has reported this since it
   *  shipped; the telescope path used to leave it in the debug log. */
  skipped: ImportSkipSummary[];
  lastRun: string | null;
  error: string | null;
  /** True when `error` describes a user-requested cancellation rather than a
   *  genuine failure. Lets callers show a cancelled run differently (or not
   *  at all) from an error that needs the user's attention — the Library
   *  page's error banner skips it entirely, since a cancellation is
   *  something the user just did, not new information. The run is still
   *  recorded in Sync History either way. */
  cancelled: boolean;
  startedAt: string | null;
  warmingThumbnails: { done: number; total: number } | null;
  /** True when the user explicitly triggered this run (Sync Now, a
   *  per-object/session sync, a folder import), false for the scheduled
   *  auto-import tick. Threaded into the importHistory row so a zero-new-file
   *  run the user asked for directly can still surface in Sync History,
   *  while a routine background tick that (correctly) found nothing stays
   *  hidden. */
  manual: boolean;
}

/** Options accepted by runImport. */
export interface RunImportOptions {
  /** Target a specific telescope. Defaults to the active profile. Every
   *  session imported during this call is stamped with this telescope's id. */
  telescopeId?: string;
  /** True when the user explicitly asked for this run (Sync Now, a
   *  per-object/session sync). Defaults false, matching the scheduled
   *  auto-import tick, which must never opt itself into being surfaced as if
   *  the user had asked for it. */
  manual?: boolean;
}

export interface ImportHistoryEntry {
  id: number;
  startedAt: string;
  finishedAt: string;
  objectsTotal: number;
  filesTotal: number;
  newFiles: number;
  bytesTotal: number;
  bytesNew: number;
  error: string | null;
  /** True when `error` describes a user-requested cancellation rather than a
   *  genuine failure. False (including for rows written before this column
   *  existed) otherwise. */
  cancelled: boolean;
  files: string[] | null; // parsed from JSON
  /** Telescope these files came from (null for folder/upload imports). */
  telescopeId: string | null;
  /** Name snapshotted at the moment of the run so a profile rename later
   *  doesn't rewrite history. */
  telescopeName: string | null;
  /** 'smb' | 'local' | 'ftp' | null — which transport ran the import. */
  transportKind: TransportKind | null;
  /** What the run left behind and why. Null for rows written before this was
   *  recorded, and for runs that skipped nothing. */
  skipped: ImportSkipSummary[] | null;
  /** True when the user explicitly triggered this run. False (including for
   *  rows written before this column existed) for a scheduled auto-import tick. */
  manual: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

let importStatus: ImportStatus = {
  running: false,
  runId: null,
  currentObject: null,
  telescopeId: null,
  telescopeName: null,
  transportKind: null,
  objectsTotal: 0,
  objectsDone: 0,
  filesTotal: 0,
  filesDone: 0,
  currentObjectFilesTotal: 0,
  currentObjectFilesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  skippedFiles: 0,
  skipped: [],
  lastRun: null,
  error: null,
  cancelled: false,
  startedAt: null,
  warmingThumbnails: null,
  manual: false,
};

let importCancelRequested = false;

/** Skip tally for the active run. `importStatus.skipped` is the summarized
 *  view, refreshed once per object so the polling UI stays current without
 *  re-sorting on every file. */
let importSkips: SkipTally = new Map();

// Active telescope context for the current runImport invocation.
// Read by the mid-loop saves so every librarySessions row written
// during this run is stamped with the telescope that captured it.
let currentImportProfile: TelescopeProfile | null = null;
let currentImportWalker: WalkerConfig = { basePath: 'MyWorks' };

// Transient tracking of new files downloaded in the current import run
let importNewFiles: Array<{ name: string; size: number }> = [];
let importBytesNew = 0;

/**
 * Request cancellation of the active import. When `runId` is given, only
 * cancels if it matches the currently active run — protects against a caller
 * that only knows about a run it itself started (e.g. the sub-frame sync
 * modal) killing an unrelated import that raced in and claimed the lock
 * after the caller's own run finished. Omit `runId` to keep the generic
 * "cancel whatever is running" behavior (the main cancel button).
 */
export function cancelImport(runId?: string): void {
  if (runId && runId !== importStatus.runId) return;
  importCancelRequested = true;
}

/**
 * Bounded concurrent worker pool over a dynamically-fed queue. Items arrive
 * via push() as they become available (e.g. a file finishing download) and
 * are drained by `concurrency` workers running `process`; call close() once
 * no more items will be pushed, then await drain() to wait for every
 * in-flight and queued item to finish. Used to let CPU-bound work (FITS
 * thumbnailing) overlap network-bound work (downloads) instead of the two
 * competing for the same await chain.
 */
export function createWorkerQueue<T>(concurrency: number, process: (item: T) => Promise<void>): {
  push: (item: T) => void;
  close: () => void;
  drain: () => Promise<void>;
} {
  const queue: T[] = [];
  let closed = false;
  const waiters: Array<() => void> = [];

  function wake(): void {
    while (waiters.length > 0 && (queue.length > 0 || closed)) {
      waiters.shift()?.();
    }
  }

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) {
        await process(item);
        continue;
      }
      if (closed) return;
      await new Promise<void>(resolve => { waiters.push(resolve); });
    }
  });

  return {
    push(item: T) { queue.push(item); wake(); },
    close() { closed = true; wake(); },
    drain: () => Promise.all(workers).then(() => undefined),
  };
}

/**
 * Pre-generate 400×400 gallery thumbnails for a set of newly-imported objects
 * so the library grid loads instantly on first view. Uses the same
 * resolveObjectImagePath logic as the thumbnail route so the generated cache
 * key is always identical to what the route will look up. Runs up to 4
 * objects concurrently to saturate the sharp/libvips thread pool.
 */
async function pregenerateObjectThumbnails(objectIds: Iterable<string>): Promise<void> {
  const THUMB_W = 400;
  const THUMB_H = 400;
  const ids = Array.from(objectIds);
  log.info({ count: ids.length }, '[thumb] Pre-generating gallery thumbnails for %d object(s)', ids.length);

  importStatus.warmingThumbnails = { done: 0, total: ids.length };

  const queue = ids.slice();
  const CONCURRENCY = 4;
  // Local counter, not a read-modify-write off importStatus.warmingThumbnails:
  // that field can be reset to null by a subsequent runImport() call (module-
  // level importStatus, guarded only by the import lock) while these workers
  // are still mid-await, which would null-deref on the next increment.
  let done = 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const objectId = queue.shift();
      if (!objectId) break;
      try {
        const srcPath = await resolveObjectImagePath(objectId);
        if (srcPath && fs.existsSync(srcPath)) {
          const mtimeMs = fs.statSync(srcPath).mtimeMs;
          const cacheKey = Buffer.from(`${srcPath}:${THUMB_W}x${THUMB_H}:${mtimeMs}`).toString('base64url');
          const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);
          if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
            await sharp(srcPath)
              .resize(THUMB_W, THUMB_H, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80, progressive: true })
              .toFile(cachePath);
          }
        }
      } catch {
        // best-effort — never block import completion
      }
      done++;
      importStatus.warmingThumbnails = { done, total: ids.length };
    }
  }));

  importStatus.warmingThumbnails = null;
}

// If a previous run left importRunning = 1 in the DB, the server crashed mid-import.
// Surface that as an error so the client doesn't silently show "No sub-frames found".
{
  const prevMeta = stmts.getImportMeta.get();
  if (prevMeta?.importRunning) {
    importStatus.error = 'The previous import was interrupted when the server restarted. Run the import again to finish it.';
    stmts.setImportRunning.run(0, null);
    console.warn('[library] Previous import was interrupted by a server restart');
  }
  const latest = stmts.getLatestHistory.get();
  if (latest) importStatus.lastRun = latest.finishedAt;
}

/**
 * Rewrite raw transport/network errors into something a user can act on.
 * Keeps the underlying message visible at the end so support can still see
 * the original signal, but leads with what went wrong and what to try next.
 *
 * Exported for tests: the wording differs per device kind and is the whole
 * point of the function, so it is worth pinning. Production callers reach it
 * through the import pipeline below.
 */
export function friendlyImportError(err: unknown, profile: TelescopeProfile | null): string {
  const raw = err instanceof Error ? err.message : 'Import failed.';
  // A custom SMB share is a NAS or a PC, not a telescope. Advice about power,
  // Wi-Fi, and booting is wrong for it, so the wording follows the kind.
  const generic = isGenericShare(profile?.kind);
  const name = profile?.name ?? `the ${deviceNoun(profile?.kind)}`;
  const host = profile?.hostname || profile?.localPath || '';
  const lower = raw.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return `${name} refused the connection${host ? ` at ${host}` : ''}. `
      + (generic
        ? 'Check that it is on, that SMB sharing is enabled, and that nothing is blocking port 445.'
        : 'Check that the telescope is powered on, on the same network, and that file sharing is enabled.');
  }
  if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout')) {
    return `${name} did not respond${host ? ` at ${host}` : ''}. `
      + (generic
        ? 'Check the address is right and that the server is on.'
        : 'Confirm it is powered on and connected to your network, then try again.');
  }
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) {
    return `Could not find ${name}${host ? ` at ${host}` : ''}. Check the hostname or IP address in Settings, Hardware.`;
  }
  if (lower.includes('ehostunreach') || lower.includes('enetunreach') || lower.includes('host is down')) {
    return `${name} is not reachable on the network. ${offlineAdvice(profile?.kind)}`;
  }
  if (lower.includes('nt_status_logon_failure') || lower.includes('logon_failure') || lower.includes('access denied')) {
    return `${name} refused the login. Open Settings, Hardware, ${name}, and check the SMB username and password.`;
  }
  if (lower.includes('nt_status_bad_network_name') || lower.includes('bad_network_name')) {
    return generic
      ? `${name} has no share by that name. Open Settings, Hardware, ${name}, and check the SMB share name.`
      : `${name} does not expose the expected file share. Make sure the telescope is fully booted and SMB sharing is on.`;
  }
  if (lower.includes('failed to connect to smb') || lower.includes('smb connection')) {
    return `Could not reach ${name}${host ? ` at ${host}` : ''} over SMB. `
      + (generic
        ? 'Check the address is right and that the server is on and sharing over SMB.'
        : 'Check that it is powered on and connected to your network, then try again.');
  }
  if (lower.includes('enoent') || lower.includes('no such file') || lower.includes('not a directory')) {
    return `Could not read from ${name}. The expected folder is missing. If this is a USB-mounted Dwarf, make sure the drive is connected.`;
  }
  return raw;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Local-disk filename to use for a Dwarf file pulled from a session folder.
 *
 *  Subframes and Dwarf II final stacks already encode `<target>_YYYY-MM-DD_...`
 *  in their basename, and Dwarf 3 RAW TELE / Dwarf II USB subframes already
 *  parse via parseFilename's dwarfRawTeleMatch branch — leave those alone. The
 *  Dwarf 3 rolling stacks
 *  (`stacked-NNNN.fits`) carry no session marker, which means:
 *    (a) two sessions for the same target would each write a file called
 *        `stacked-0001.fits` into the same library object folder and clobber
 *        each other;
 *    (b) `parseFilename` can't pull a date out, so the file becomes invisible
 *        to any session-date filtered listing.
 *
 *  For those files, prefix the basename with `DWARF3_<target>_<timestamp>_`
 *  using the data encoded in the source session folder name. The result
 *  parses cleanly through the Dwarf branch in `parseFilename` and is unique
 *  per (target, session). Returns the basename unchanged when the session
 *  folder can't be decoded — better an ugly local name than no file at all.
 */
/** Resolve a library object directory from an objectName (which is sourced
 *  from SMB listings and therefore caller-controlled). Strips characters that
 *  would let a malicious path escape LIBRARY_DIR. Returns null when the result
 *  is empty or escapes the root — callers should skip that object. */
function safeObjectDir(objectName: string): string | null {
  const LIBRARY_DIR = getLibraryDir();
  const safe = objectName.replace(/[\/\\<>:"|?*\x00-\x1f]/g, '_').trim();
  if (!safe) return null;
  const resolved = path.resolve(LIBRARY_DIR, safe);
  if (resolved !== LIBRARY_DIR && !resolved.startsWith(LIBRARY_DIR + path.sep)) return null;
  return resolved;
}

/** True when a filename from a remote (SMB) directory listing is safe to use
 *  as a `path.join(objLocalDir, name)` local filename. A hostile or buggy
 *  SMB server returning an entry like "../../etc/passwd" as a plain file
 *  name would otherwise let a download escape the object folder — path.join
 *  normalizes ".." segments through, it doesn't sandbox them. SeeStar file
 *  listings are always flat (no separators expected in a real file name);
 *  Dwarf listings intentionally encode "<sessionFolder>/<basename>" and are
 *  parsed separately, so this guard is not used there. */
function isSafeRemoteFileName(name: string): boolean {
  if (name.length === 0 || name.includes('/') || name.includes('\\')) return false;
  // No separator needed to escape objLocalDir via path.join when the whole
  // name is a traversal token itself (a malicious server reporting a "file"
  // literally named ".." would resolve to the parent directory).
  if (name === '.' || name === '..') return false;
  return true;
}

function sanitizeDwarfSubPath(rawParts: string[]): string | null {
  const safeParts: string[] = [];
  for (const part of rawParts) {
    const safe = sanitizeSessionFolder(part);
    if (!safe) return null;
    safeParts.push(safe);
  }
  return safeParts.join('/');
}

/** What the Dwarf naming step decided about one remote file: the name to save
 *  it as, or the reason it cannot be imported. The reason is carried rather
 *  than a bare null so the caller can report the drop to the user in the same
 *  words the folder-import wizard uses, instead of only to the debug log. */
export type DwarfNameResult =
  | { name: string }
  | { name: null; reason: ImportSkipReason };

export function dwarfLocalName(basename: string, sessionFolder: string): DwarfNameResult {
  const keep = (name: string): DwarfNameResult => ({ name });
  const skip = (reason: ImportSkipReason): DwarfNameResult => ({ name: null, reason });

  // Dwarf 3 session folders start with DWARF3_RAW_; everything else (Dwarf II,
  // Dwarf Mini) starts with DWARF_RAW_. Use the matching prefix in renamed
  // files so the model is identifiable from the filename.
  const prefix = sessionFolder.startsWith('DWARF3_RAW_') ? 'DWARF3_' : 'DWARF_';

  // Dwarf 3 subframes already carry an ISO-format date (_YYYY-MM-DD_HH-MM-SS).
  if (/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(basename)) return keep(basename);
  // Dwarf 3 RAW TELE / Dwarf II USB subframes
  // (<object>_<exp>s<gain>_<mode>_<YYYYMMDD>-<HHMMSS>[mmm]_<temp>C.<ext>) already
  // round-trip through parseFilename's dwarfRawTeleMatch branch, so leave them
  // as-is: reformatting would discard exposure, gain, and temperature, which are
  // real metadata the original name encodes and a reformat can't recover
  // ("IC 1396_60s60_Duo-Band_20260705-232743713_31C.fits" reported as more useful
  // than the renamed form).
  const parsed = parseFilename(basename);
  if (parsed.type === 'sub' && parsed.date) return keep(basename);
  // Dwarf II / Mini USB subframes embed the timestamp as YYYYMMDDs-HHMMSSmmm
  // (no ISO separators). Reformat to <prefix><target>_<YYYY-MM-DD>_<HH-MM-SS>-<ms>[_<mode>]_sub.<ext>
  // so parseFilename can extract the date and filter for session/filter queries.
  // Use [A-Za-z0-9-]+ for the mode token (not \w+) so Duo-Band is captured correctly.
  // (Kept as a fallback for any subframe shape the check above doesn't recognize.)
  const dwarfIISubMatch = basename.match(
    /^.+?_\d+\.?\d*s\d+_([A-Za-z0-9-]+)_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{1,3})_\d+C\.(fits?)$/i,
  );
  if (dwarfIISubMatch) {
    const subTarget = extractTargetFromSessionFolder(sessionFolder);
    if (!subTarget) return skip('undecodable-session-folder');
    const [, mode, y, mo, d, hh, mm, ss, ms, ext] = dwarfIISubMatch;
    const targetSlug = subTarget.replace(/[\s/\\<>:"|?*\x00-\x1f]/g, '_');
    // Include mode token so parseFilename can recover the filter type later.
    // _sub suffix tells parseFilename this is a raw individual exposure.
    return keep(`${prefix}${targetSlug}_${y}-${mo}-${d}_${hh}-${mm}-${ss}-${ms}_${mode}_sub.${ext}`);
  }
  const target = extractTargetFromSessionFolder(sessionFolder);
  const timestamp = extractTimestampFromSessionFolder(sessionFolder);
  // When we can't decode the session folder, returning the bare basename
  // lets two sessions on the same target overwrite each other (every
  // `stacked-0001.fits` lands at the same path). Refusing the file lets the
  // caller skip and report it rather than silently collide.
  if (!target || !timestamp) return skip('undecodable-session-folder');
  const extMatch = basename.match(/\.(fits?|jpe?g|png|tiff?|json|txt)$/i);
  if (!extMatch) return skip('unsupported-type');
  const stem = basename.slice(0, -extMatch[0].length);
  // Sanitize target — Dwarf folder names can contain arbitrary SMB-legal
  // characters; we must never let those out into a filesystem path.
  const targetSlug = target.replace(/[\s/\\<>:"|?*\x00-\x1f]/g, '_');

  // Rolling stacks: `stacked-16_HD 279230_...` → use only the counter as suffix
  // so parseFilename can round-trip the date and type from the local filename.
  // Using the full original stem produces names that parseFilename can't match,
  // which causes the file to have no parsed date and be invisible to all session
  // queries even after it is imported to disk.
  const rollingStackMatch = stem.match(/^stacked-(\d+)/i);
  if (rollingStackMatch) {
    return keep(`${prefix}${targetSlug}_${timestamp}_stacked-${rollingStackMatch[1]}${extMatch[0]}`);
  }

  // Plain preview (`stacked.jpg`): no numeric counter, no suffix needed — single
  // instance per session+extension so no collision risk.
  if (/^stacked$/i.test(stem)) {
    return keep(`${prefix}${targetSlug}_${timestamp}${extMatch[0]}`);
  }

  // Thumbnail (`stacked_thumbnail.jpg`): rename to the `_thn` convention so
  // parseFilename recognises isThumbnail and classifyImportFile gates it behind
  // the importThumbnails setting (default: off).
  if (/^stacked_thumbnail$/i.test(stem)) {
    return keep(`${prefix}${targetSlug}_${timestamp}_thn${extMatch[0]}`);
  }

  // Internal Dwarf processing artifacts (reference frame, stacking counter)
  // start with img_ and are not science outputs. `img_stacked_all` is the one
  // exception — it is the master integration — so it falls through to the
  // generic rename below and lands as `<prefix><target>_<ts>_img_stacked_all.tif`.
  // classifyImportFile draws the same line; this runs first, so it has to agree.
  if (/^img_/i.test(stem) && !isDwarfMasterStack(basename)) return skip('processing-artifact');

  // Everything else: sanitize the stem and keep it so different same-session
  // files don't collide.
  const safeStem = stem.replace(/[\s/\\<>:"|?*\x00-\x1f]/g, '_');
  return keep(`${prefix}${targetSlug}_${timestamp}_${safeStem}${extMatch[0]}`);
}

/** Observing-night date for a Dwarf session folder, using the folder's own
 *  start time (extractTimestampFromSessionFolder) so a session whose folder
 *  was created just after local midnight still groups with the prior
 *  evening. Returns null when the folder name doesn't parse. */
function dwarfFolderNightDate(sessionFolder: string): string | null {
  const date = extractDateFromSessionFolder(sessionFolder);
  if (!date) return null;
  const ts = extractTimestampFromSessionFolder(sessionFolder);
  const hmsMatch = ts?.match(/(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/);
  const hms = hmsMatch ? `${hmsMatch[1]}${hmsMatch[2]}${hmsMatch[3]}` : null;
  return observingNightDate(date, hms);
}

// ─── SMB import ─────────────────────────────────────────────────────────────

// TODO(perf backlog, not this pass): the import loops below still call
// fs.existsSync/statSync/readdirSync synchronously against what may be a
// network-mounted library. That's the right long-term move — purgeJunkFiles
// and isLibraryAvailable already made the same conversion (async + a
// withTimeout wrapper) for the same reason — but it touches every loop in
// this file and deserves its own pass rather than a partial one bundled into
// the download-pipelining work above it.

/**
 * Import all objects (or a specific one) from SMB to local library.
 * Skips files that are already present locally.
 *
 * When targetDate is provided, only files for that session date are fetched,
 * and FITS files are always included regardless of importFits setting.
 */
export async function runImport(
  targetObjectId?: string,
  targetDate?: string,
  options?: RunImportOptions,
): Promise<void> {
  // Outer try/finally: callers claim the lock via claimImportLock() before
  // invoking, expecting it to always be released. Everything below this
  // point used to run unguarded until the inner try (line ~534) — a throw
  // from selectActiveTransport, writeIdentityIfMissing, or markTransportSeen
  // would propagate to the route's .catch(console.error) with nobody
  // releasing, permanently 409-ing every future import. releaseImportLock()
  // is idempotent, so this is a pure safety net over the existing release
  // paths below, not a replacement for them.
  try {
  // Resolve aliases so "C30" and "NGC7331" always land on the same objectId.
  if (targetObjectId) targetObjectId = resolveCanonicalId(targetObjectId);
  const baseProfile = options?.telescopeId ? getProfileById(options.telescopeId) : null;
  if (!baseProfile) {
    importStatus.error = 'No telescope was selected for this import. Open Settings, Hardware, and pick the telescope you want to pull from.';
    importStatus.running = false;
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    try { stmts.setImportRunning.run(0, null); } catch (err) {
      console.warn('[import] setImportRunning failed:', err instanceof Error ? err.message : err);
    }
    return;
  }
  // Resolve which transport (SMB vs USB) to use for this run. Local mount
  // wins when present; otherwise we use the configured SMB transport. The
  // selected transport's connection fields override the profile's legacy
  // mirror columns for the rest of this import.
  const activeTransport = selectActiveTransport(baseProfile.id);
  const profile: TelescopeProfile = activeTransport
    ? {
        ...baseProfile,
        connectionType: activeTransport.kind,
        hostname: activeTransport.hostname,
        shareName: activeTransport.shareName,
        username: activeTransport.username,
        password: activeTransport.password,
        localPath: activeTransport.localPath,
      }
    : baseProfile;
  // Local-fs profiles (Dwarf USB) have no hostname; require a localPath instead.
  const transportAddress = profile.connectionType === 'local' ? profile.localPath : profile.hostname;
  if (!transportAddress) {
    importStatus.error = profile.connectionType === 'local'
      ? `"${profile.name}" is set to USB mode but no local path is configured. Open Settings, Hardware, ${profile.name}, and set the path to your telescope's storage.`
      : `"${profile.name}" has no hostname configured. Open Settings, Hardware, ${profile.name}, and enter the telescope's IP address or hostname.`;
    importStatus.running = false;
    importStatus.telescopeId = profile.id;
    importStatus.telescopeName = profile.name;
    try { stmts.setImportRunning.run(0, null); } catch (err) {
      console.warn('[import] setImportRunning failed:', err instanceof Error ? err.message : err);
    }
    return;
  }
  currentImportProfile = profile;
  currentImportWalker = getWalkerConfig(profile.kind);
  const walkerBase = currentImportWalker.basePath;

  log.info(
    {
      telescopeId: profile.id,
      telescopeName: profile.name,
      kind: profile.kind,
      transport: profile.connectionType ?? 'smb',
      address: transportAddress,
      targetObjectId: targetObjectId ?? null,
      targetDate: targetDate ?? null,
    },
    '[import] Starting import from %s (%s) at %s via %s%s%s',
    profile.name, profile.kind, transportAddress, profile.connectionType ?? 'smb',
    targetObjectId ? ` — object: ${targetObjectId}` : '',
    targetDate ? ` date: ${targetDate}` : '',
  );

  debugLog('import:start', `Telescope: "${profile.name}" (${profile.kind}) | Address: ${transportAddress} | Connection: ${profile.connectionType ?? 'smb'} | Walker base: ${walkerBase}`);
  if (targetObjectId) debugLog('import:start', `Target object: ${targetObjectId}${targetDate ? ` | Date: ${targetDate}` : ''}`);

  // Lock is managed by claimImportLock() — callers must acquire it first
  importCancelRequested = false;
  importStatus = {
    running: true,
    runId: randomUUID(),
    currentObject: null,
    telescopeId: profile.id,
    telescopeName: profile.name,
    transportKind: activeTransport ? activeTransport.kind : profile.connectionType,
    objectsTotal: 0,
    objectsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    currentObjectFilesTotal: 0,
    currentObjectFilesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    skippedFiles: 0,
    skipped: [],
    lastRun: importStatus.lastRun,
    error: null,
    cancelled: false,
    startedAt: new Date().toISOString(),
    warmingThumbnails: null,
    manual: options?.manual ?? false,
  };
  importNewFiles = [];
  importBytesNew = 0;
  importSkips = new Map();

  // Stamp this run's deviceId from `.nebulis.dat` if the user has tracking
  // enabled (default) and we can read or write it. Used to key
  // sessionImportLog so the same file reached via SMB or USB collides on one
  // row. Best-effort: failures fall back to the profile's existing deviceId
  // (possibly null), in which case dedup falls back to the legacy
  // (telescopeId, remotePath) index.
  let runDeviceId: string | null = baseProfile.deviceId ?? null;
  if (activeTransport && baseProfile.trackDeviceIdentity) {
    try {
      const probe = await writeIdentityIfMissing(activeTransport, { model: profile.model });
      markTransportSeen(activeTransport.id);
      if (!runDeviceId) {
        runDeviceId = probe.identity.deviceId;
        setProfileDeviceId(profile.id, runDeviceId);
      }
    } catch {
      /* identity is best-effort; carry on with whatever runDeviceId we have */
    }
  } else if (activeTransport) {
    // Still mark the transport seen even when identity is disabled so the
    // "last seen" timestamp on the row stays meaningful.
    markTransportSeen(activeTransport.id);
  }

  try {
  ensureLibraryDir();
  // File-type filters are per-telescope now. Pull them off the profile, with
  // global appSettings as a fallback for any field a profile happens to be
  // missing (shouldn't happen post-migration, but the merge keeps things safe
  // if a new field is added later). Per-session sync still force-enables FITS.
  const rawSettings = loadSettings();
  const profileSettings = {
    importJpg: profile.importJpg,
    importFits: profile.importFits,
    importThumbnails: profile.importThumbnails,
    importSubFrames: profile.importSubFrames,
    importVideos: profile.importVideos,
    archiveAllFiles: profile.archiveAllFiles,
  };
  const settings = targetDate
    ? { ...rawSettings, ...profileSettings, importFits: true }
    : { ...rawSettings, ...profileSettings };
  debugLog('import:settings', `JPG: ${settings.importJpg !== false}, FITS: ${settings.importFits !== false}, Thumbnails: ${settings.importThumbnails !== false}, Sub-frames: ${settings.importSubFrames === true}, Videos: ${settings.importVideos === true}, Archive-all: ${settings.archiveAllFiles === true}`)
  const preferCaldwell = rawSettings.preferredCatalog === 'caldwell';
  const index = loadIndex();

  // Per-file shape after vendor-specific discovery. `localName` is what we
  // save the file as on disk; `remotePath` is what we pass to smbGetFile.
  // `date` is the session date (Dwarf reads it from the session folder name;
  // SeeStar reads it from the filename's timestamp).
  interface ImportFile {
    localName: string;
    /** Session directory to place this file in, for a nested object. null puts
     *  it at object level, which is what every flat object does. */
    sessionFolder: string | null;
    /** The name the device gave the file, before any rename on the way in.
     *  Recorded in libraryFiles so the original is never lost even while
     *  dwarfLocalName still rewrites the handful of names that carry no date. */
    originalName: string;
    remotePath: string;
    size?: number;
    fromSub: boolean;
    date: string | null;
  }

  const isDwarf = isDwarfKind(profile.kind);

  // Vendor-specific object discovery.
    interface ObjectToImport {
      objectName: string;
      subFolderName: string | null;
      // Only set for Dwarf: the real session folders under Astronomy/.
      dwarfSessionFolders: string[];
      // Set when this entry was expanded from a container folder (e.g. Planetary_Photo).
      // Used as the SMB path for file listing; objectName becomes the library destination.
      remoteFolderName?: string;
      // When set, only filenames in this set are imported (used with remoteFolderName).
      fileNameFilter?: Set<string>;
    }
    let toImport: ObjectToImport[];
    if (isDwarf) {
      debugLog('import:discover', `Dwarf: scanning ${transportAddress} for objects`);
      const discovered = await discoverDwarfObjects(profile);
      debugLog('import:discover', `Dwarf: found ${discovered.length} object(s) total`);
      if (discovered.length > 0) debugLog('import:discover', `Objects: ${discovered.map(o => o.folderName).join(', ')}`);
      toImport = discovered
        .filter(o => !targetObjectId || resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId)
        .filter(o => !index.objects[resolveCanonicalId(normalizeObjectId(o.folderName))]?.deleted)
        .map(o => ({
          objectName: o.folderName,
          subFolderName: null,
          dwarfSessionFolders: o._dwarfSessionFolders ?? [],
        }));
    } else {
      debugLog('import:discover', `SeeStar: connecting to ${transportAddress}, listing ${walkerBase || '/'}`);
      const entries = await smbListDir(walkerBase, profile);
      const objectFolders = entries.filter(e => e.type === 'dir' && isObjectFolder(e.name));
      const subFolders = entries.filter(e => e.type === 'dir' && isSubFolder(e.name));
      debugLog('import:discover', `SeeStar: found ${objectFolders.length} object folder(s), ${subFolders.length} sub folder(s)`);
      if (objectFolders.length > 0) debugLog('import:discover', `Objects: ${objectFolders.map(e => e.name).join(', ')}`);

      // Container folders (e.g. SeeStar dumps all planetary images into
      // Planetary_Photo regardless of which planet was imaged) are the only
      // ones worth peeking inside: expand those into one entry per target name.
      //
      // Unlike the folder-import wizard, this path deliberately does not apply
      // planObjectFolder's split/rename rules to ordinary folders. The device
      // already names each folder for its target, so re-deriving names from
      // filenames could rename objects already in the library, and peeking
      // inside every folder would cost an SMB round trip each. See
      // objectDiscovery.ts, which owns both policies.
      const expandedEntries: ObjectToImport[] = [];
      const normalFolders: typeof objectFolders = [];

      for (const entry of objectFolders) {
        if (!isContainerFolder(entry.name)) {
          normalFolders.push(entry);
          continue;
        }
        try {
          const innerPath = walkerBase ? `${walkerBase}/${entry.name}` : entry.name;
          const innerEntries = await smbListDir(innerPath, profile);
          const innerFiles = innerEntries.filter(e => e.type === 'file');
          debugLog('import:discover', `SeeStar: container folder "${entry.name}" expanded — ${innerFiles.length} file(s)`);
          const { byTarget } = groupByTarget(innerFiles.map(e => e.name));
          for (const [target, fileNames] of byTarget) {
            debugLog('import:discover', `SeeStar: container "${entry.name}" → target "${target}" (${fileNames.length} file(s))`);
            expandedEntries.push({
              objectName: target,
              // Containers hold planetary captures, which never produce
              // sub-frames, so there is no `<container>_sub` to attach.
              subFolderName: null,
              dwarfSessionFolders: [],
              remoteFolderName: entry.name,
              fileNameFilter: new Set(fileNames),
            });
          }
        } catch {
          // Cannot peek inside — fall back to importing as a regular folder.
          normalFolders.push(entry);
        }
      }

      toImport = [
        ...(targetObjectId
          ? normalFolders.filter(e => resolveCanonicalId(normalizeObjectId(e.name)) === targetObjectId)
          : normalFolders
        )
          .filter(e => !index.objects[resolveCanonicalId(normalizeObjectId(e.name))]?.deleted)
          .map(objEntry => ({
            objectName: objEntry.name,
            subFolderName: subFolders.find(s => getObjectFromSubFolder(s.name) === objEntry.name)?.name ?? null,
            dwarfSessionFolders: [],
          })),
        ...expandedEntries
          .filter(e => !targetObjectId || resolveCanonicalId(normalizeObjectId(e.objectName)) === targetObjectId)
          .filter(e => !index.objects[resolveCanonicalId(normalizeObjectId(e.objectName))]?.deleted),
      ];
    }

    importStatus.objectsTotal = toImport.length;
    debugLog('import:queue', `${toImport.length} object(s) queued for import`);

    // Enrichment (Wikipedia/SIMBAD) and weather backfill are both external
    // network calls; running them per-object inside the download loop stalled
    // progress on their latency between every object's files. Collected here
    // and run in a post-pass after the loop, same as commitFolderImport.
    const touchedObjectIds = new Set<string>();

    for (const obj of toImport) {
      if (importCancelRequested) { importStatus.error = 'Import cancelled. Files already downloaded were kept; the rest will be picked up on the next run.'; importStatus.cancelled = true; break; }
      const { objectName } = obj;
      importStatus.currentObject = objectName;
      debugLog('import:object', `Processing: ${objectName}`);

      // Decide the on-disk shape before enumerating files, because it changes
      // both where a file lands and whether its name is rewritten. An object
      // that already exists keeps whatever shape it has — mixing both inside
      // one folder would put some of a session beside the folder holding the
      // rest, which no read path could explain.
      const objIdForLayout = resolveCanonicalId(normalizeObjectId(objectName));
      const objectLayout = layoutForImport(objIdForLayout, !!index.objects[objIdForLayout]);

      // Vendor-specific file enumeration → unified ImportFile[].
      let allFiles: ImportFile[] = [];
      if (isDwarf) {
        // One unreadable Dwarf session folder (corrupt directory entry, a
        // transient USB read error) must not abort every remaining object —
        // the SeeStar branch below already isolates per-folder listing
        // failures the same way.
        let files: Array<{ name: string; size?: number }>;
        let subFiles: Array<{ name: string; size?: number }>;
        try {
          ({ files, subFiles } = await listDwarfObjectFiles(
            profile,
            {
              folderName: objectName,
              subFolderName: null,
              _dwarfSessionFolders: obj.dwarfSessionFolders,
            },
            // Archive mode means everything, including the per-frame previews
            // the device keeps in a session sub-directory.
            { includeSubDirs: settings.archiveAllFiles === true },
          ));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          debugLog('import:error', `Failed to list Dwarf session files for "${objectName}" — ${reason}`);
          console.error(`[import] Failed to list Dwarf session files for "${objectName}":`, reason);
          const msg = `Could not read session files for "${objectName}" (${reason}).`;
          importStatus.error = importStatus.error ? `${importStatus.error}; ${msg}` : msg;
          importStatus.objectsDone++;
          continue;
        }
        const toImportFile = (e: { name: string; size?: number }, fromSub: boolean): ImportFile | null => {
          // listDwarfObjectFiles tags entries as `<sessionFolder>/<basename>`, or
          // `<sessionFolder>/<subDir>/<basename>` for a file inside a session
          // sub-directory (archive mode only). The sub-directory is preserved on
          // disk so the copy mirrors the device instead of flattening it.
          const parts = e.name.split('/');
          const sessionFolder = parts.length > 1 ? parts[0] : '';
          const subPath = sanitizeDwarfSubPath(parts.slice(1, -1));
          const basename = parts[parts.length - 1];
          const night = dwarfFolderNightDate(sessionFolder);

          // Nested: mirror the device's own session directory and keep the file
          // name exactly as the Dwarf wrote it. dwarfLocalName is not consulted
          // at all — everything it was stamping into the name (target, session
          // timestamp, uniqueness across sessions) is now carried by the path.
          // A session folder we cannot decode is no longer a reason to refuse
          // the file either: the folder is copied verbatim, so the files land
          // intact and simply carry no date until something better turns up.
          if (objectLayout === 'nested') {
            if (!isSafeRemoteFileName(basename) || subPath === null) {
              debugLog('import:dwarf', `Skipping Dwarf file (unsafe path): ${e.name}`);
              countSkip(importSkips, 'unsupported-type');
              return null;
            }
            const sessionDir = sessionFolderFor(sessionFolder || null, night, null);
            const dir = sessionDir && subPath ? `${sessionDir}/${subPath}` : sessionDir;
            if (!dir) {
              debugLog('import:dwarf', `Skipping Dwarf file (unusable session folder): ${e.name}`);
              countSkip(importSkips, 'undecodable-session-folder');
              return null;
            }
            return {
              localName: basename,
              sessionFolder: dir,
              originalName: basename,
              remotePath: buildDwarfFilePath(e.name),
              size: e.size,
              fromSub,
              date: night,
            };
          }

          const named = dwarfLocalName(basename, sessionFolder);
          if (named.name === null) {
            debugLog('import:dwarf', `Skipping Dwarf file (${named.reason}): ${e.name}`);
            countSkip(importSkips, named.reason);
            return null;
          }
          return {
            localName: named.name,
            sessionFolder: null,
            originalName: basename,
            remotePath: buildDwarfFilePath(e.name),
            size: e.size,
            fromSub,
            date: night,
          };
        };
        const isImportFile = (f: ImportFile | null): f is ImportFile => f !== null;
        // Sub-frames are dropped here rather than fed through the filter below
        // so we never pay to name thousands of files we already know we are not
        // importing. They are still counted: this listing is already in hand, so
        // reporting the exact number is free.
        // Archive mode keeps everything, so sub-frames must not be dropped here
        // before classifyImportFile is ever consulted.
        const wantSubFrames = settings.importSubFrames === true || settings.archiveAllFiles === true;
        if (!wantSubFrames) {
          countSkip(importSkips, 'sub-frames-disabled', subFiles.length,
            subFiles.reduce((sum, f) => sum + (f.size ?? 0), 0));
        }
        allFiles = [
          ...files.map(f => toImportFile(f, false)).filter(isImportFile),
          ...(wantSubFrames ? subFiles.map(f => toImportFile(f, true)).filter(isImportFile) : []),
        ];
      } else {
        // For entries expanded from a container folder (e.g. Planetary_Photo/Jupiter),
        // the remote SMB folder differs from the local object name.
        const remoteFolderName = obj.remoteFolderName ?? objectName;
        const smbObjectPath = walkerBase ? `${walkerBase}/${remoteFolderName}` : remoteFolderName;
        debugLog('import:discover', `SeeStar: listing ${smbObjectPath} for object "${objectName}"`);
        let files: Array<{ name: string; size?: number }> = [];
        try {
          const entries = await smbListDir(smbObjectPath, profile);
          files = entries
            .filter(e => e.type === 'file')
            .filter(e => isSafeRemoteFileName(e.name))
            .filter(e => !obj.fileNameFilter || obj.fileNameFilter.has(e.name));
          debugLog('import:discover', `SeeStar: ${files.length} file(s) in ${smbObjectPath}`);
        } catch {
          debugLog('import:error', `Failed to list ${smbObjectPath} for "${objectName}"`);
          importStatus.objectsDone++;
          continue;
        }
        let subFiles: Array<{ name: string; size?: number }> = [];
        // Unlike the Dwarf branch above, a disabled sub-frame setting is not
        // reported with a count here: the `_sub` folder is never listed, and
        // listing one per object on every run purely to report a number the
        // user's own setting explains would add an SMB round trip per object to
        // every auto-import.
        // Archive mode wants the `_sub` companion listed too, so it is not gated
        // on importSubFrames alone.
        if ((settings.importSubFrames === true || settings.archiveAllFiles === true) && obj.subFolderName) {
          try {
            const smbSubPath = walkerBase ? `${walkerBase}/${obj.subFolderName}` : obj.subFolderName;
            debugLog('import:discover', `SeeStar: listing sub-frames from ${smbSubPath}`);
            const subEntries = await smbListDir(smbSubPath, profile);
            subFiles = subEntries.filter(e => e.type === 'file' && isSafeRemoteFileName(e.name));
            debugLog('import:discover', `SeeStar: ${subFiles.length} sub-file(s) in ${smbSubPath}`);
          } catch { /* ignore */ }
        }
        const toImportFile = (e: { name: string; size?: number }, fromSub: boolean): ImportFile => ({
          localName: e.name,
          // SeeStar has no session directory of its own — files sit flat in the
          // target folder — so a nested object gets a canonical one built from
          // the file's own observing night. sessionFolderFor falls back to that
          // form whenever there is no source folder to mirror.
          sessionFolder: objectLayout === 'nested'
            ? sessionFolderFor(null, sessionNightFor(parseFilename(e.name)), null)
            : null,
          // SeeStar names already parse, so this path never renames — original
          // and local are the same string by construction.
          originalName: e.name,
          remotePath: buildObjectFilePath(
            currentImportWalker,
            { folderName: remoteFolderName, subFolderName: obj.subFolderName },
            e.name,
            fromSub,
          ),
          size: e.size,
          fromSub,
          date: sessionNightFor(parseFilename(e.name)),
        });
        allFiles = [
          ...files.map(f => toImportFile(f, false)),
          ...subFiles.map(f => toImportFile(f, true)),
        ];
      }

      // Computed before the tombstone filter below: the index (and its
      // deletedSessions) is keyed by canonical id, not the raw telescope
      // folder name, so an aliased folder ("NGC 7089", "C63", "Lunar") must
      // resolve to the same id used to look up deletedSessions or a deleted
      // session silently re-imports on the next run.
      const objIdNormalized = resolveCanonicalId(normalizeObjectId(objectName));

      let filteredType = 0; let filteredTombstone = 0; let filteredDate = 0;
      allFiles = allFiles.filter(f => {
        // `fromSubFolder` makes the directory the authority over the filename,
        // matching the folder-import wizard: a JPG preview the firmware dropped
        // into a `_sub` folder must not ride in under the JPG setting.
        const decision = classifyImportFile(f.localName, settings, { fromSubFolder: f.fromSub });
        if (!decision.import) { filteredType++; countSkip(importSkips, decision.reason, 1, f.size ?? 0); return false; }
        // Never re-import tombstoned sessions (strict policy)
        if (f.date && index.objects[objIdNormalized]?.deletedSessions?.includes(f.date)) {
          filteredTombstone++;
          countSkip(importSkips, 'deleted-session');
          return false;
        }
        // Deliberately not tallied: a per-session sync asks for exactly one
        // date, so every other file is out by the user's own request. Counting
        // it would report the whole telescope as "left behind" on every
        // single-session sync.
        if (targetDate) { if (f.date !== targetDate) { filteredDate++; return false; } }
        return true;
      });
      importStatus.skipped = summarizeSkips(importSkips);
      if (filteredType > 0) debugLog('import:object', `${objectName}: ${filteredType} file(s) filtered by type settings`);
      if (filteredTombstone > 0) debugLog('import:object', `${objectName}: ${filteredTombstone} file(s) filtered by tombstoned session`);
      if (filteredDate > 0) debugLog('import:object', `${objectName}: ${filteredDate} file(s) filtered by non-matching date`);
      debugLog('import:object', `${objectName}: ${allFiles.length} file(s) to consider (after filtering)`);

      // Skip empty SeeStar folders. SeeStar sometimes creates an object
      // directory (e.g. M42) before any frames are captured, or leaves a
      // husk after a failed session. Don't create a library object for a
      // folder with no importable .fit/.jpg/sub files and no prior import
      // record — otherwise the gallery fills with placeholder entries that
      // have zero sessions.
      const hasPriorImport = !!index.objects[objIdNormalized];
      debugLog('import:object', `${objectName}: ${allFiles.length} file(s) to process${hasPriorImport ? ' (prior import exists)' : ' (new object)'}`);
      if (allFiles.length === 0 && !hasPriorImport) {
        console.log(`[import] Skipping empty folder: ${objectName}`);
        importStatus.objectsDone++;
        continue;
      }

      // Reuse the object's stored folder name if it already exists in the
      // library. Otherwise this always lands on the canonical id, which
      // diverges from a folder a prior import (e.g. via the folder wizard)
      // created under the literal source name — orphaning those files even
      // though both designations resolve to the same object (e.g. importing
      // "C63" from the telescope when files already live under "NGC7293").
      const existingSmbFolderName = index.objects[objIdNormalized]?.folderName;
      const newObjectFolderName = applyCatalogPreference(objIdNormalized, preferCaldwell);
      const objLocalDir = safeObjectDir(existingSmbFolderName || newObjectFolderName);
      if (!objLocalDir) {
        console.warn(`[import] Skipping object with unsafe name: ${objectName}`);
        importStatus.objectsDone++;
        continue;
      }
      if (!fs.existsSync(objLocalDir)) {
        fs.mkdirSync(objLocalDir, { recursive: true });
        debugLog('import:object', `Created library directory: ${objLocalDir}`);
      }

      importStatus.filesTotal += allFiles.length;
      importStatus.bytesTotal += allFiles.reduce((sum, f) => sum + (f.size || 0), 0);
      importStatus.currentObjectFilesTotal = allFiles.length;
      importStatus.currentObjectFilesDone = 0;

      const sessionSet = new Set<string>();
      let fileCount = 0;
      let downloadErrors = 0;
      let firstDownloadError: string | null = null;
      let downloadsCancelled = false;

      // FITS thumbnailing runs on its own bounded worker pool: previously it
      // was awaited inline right after each file's write, so the CPU-bound
      // sharp/libvips work stalled the next file's download instead of
      // overlapping it.
      const thumbnailQueue = createWorkerQueue<string>(4, async localPath => {
        await generateFitsThumbnail(localPath).catch(err =>
          console.warn(`[thumb] ${path.basename(localPath)}:`, err instanceof Error ? err.message : err),
        );
      });

      const objFolderName = path.basename(objLocalDir);
      /** Object-relative destination for a file: `<session>/<name>` when nested. */
      const destRelFor = (file: ImportFile): string =>
        file.sessionFolder ? `${file.sessionFolder}/${file.localName}` : file.localName;
      /** Record the per-file row. `date` from the walker is an observing night
       *  (already rolled), not a raw capture instant, so it is only pinned as
       *  an override when the filename itself yields no date to derive from —
       *  passing a rolled night in as captureDate would roll it a second time
       *  on every read. Same rule the backfill uses. */
      const recordFile = (file: ImportFile, bytes: number): void => {
        const parsed = parseFilename(file.localName);
        recordLibraryFile({
          objectId: objIdNormalized,
          folderName: objFolderName,
          sessionFolder: file.sessionFolder,
          fileName: file.localName,
          originalName: file.originalName,
          role: roleForFile(file.localName, { fromSubFolder: file.fromSub }),
          captureDate: parsed.date ?? null,
          captureTime: parsed.timestamp ? parsed.timestamp.slice(-6) : null,
          sessionDateOverride: parsed.date ? null : file.date,
          telescopeId: profile.id,
          bytes,
          sourcePath: file.remotePath,
        });
      };

      const downloadOne = async (file: ImportFile): Promise<void> => {
        const destRel = destRelFor(file);
        const localPath = path.resolve(objLocalDir, destRel);
        const objRoot = path.resolve(objLocalDir);
        let tmpPath: string | null = null;
        try {
          if (localPath !== objRoot && !localPath.startsWith(objRoot + path.sep)) {
            throw new Error(`Refusing to write outside object directory: ${destRel}`);
          }

          // Skip if already exists
          if (fs.existsSync(localPath)) {
            debugLog('import:file', `Skip (exists): ${objectName}/${destRel}`);
            importStatus.filesDone++;
            importStatus.currentObjectFilesDone++;
            importStatus.skippedFiles++;
            importStatus.bytesDone += file.size || 0;
            fileCount++;
            // Still record it: a re-run is how files imported before this table
            // existed acquire a row without waiting for the boot backfill.
            let onDiskBytes = file.size || 0;
            if (!onDiskBytes) {
              try { onDiskBytes = fs.statSync(localPath).size; } catch { /* best effort */ }
            }
            recordFile(file, onDiskBytes);
            if (file.date) {
              sessionSet.add(file.date);
            } else if (/\.jpe?g$/i.test(file.localName)) {
              const d = exifDateFromFile(localPath);
              if (d) sessionSet.add(d);
            }
            return;
          }

          tmpPath = `${localPath}.tmp`;
          debugLog('import:file', `Downloading: ${objectName}/${destRel}${file.size != null ? ` (${(file.size / 1024).toFixed(0)} KB)` : ''}`);
          // Nested files land in a per-session directory that may not exist yet.
          if (file.sessionFolder) {
            await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
          }
          let bytes: number;
          // Local (USB) is already a filesystem and FTP can stream its data
          // socket to a file — copy directly instead of reading the whole file
          // into memory first, which doubles the RAM cost for large FITS and
          // video files.
          if (supportsStreamedCopy(profile)) {
            await smbCopyFileTo(file.remotePath, tmpPath, profile);
            bytes = (await fs.promises.stat(tmpPath)).size;
          } else {
            const data = await smbGetFile(file.remotePath, undefined, profile);
            bytes = data.length;
            // Async write: a synchronous writeFileSync of a multi-MB FITS
            // blocks the event loop for the whole write, stalling every
            // concurrent request (e.g. a page refresh) until it finishes.
            // Yielding here keeps the server responsive during background
            // auto-imports.
            await fs.promises.writeFile(tmpPath, data);
          }
          if (file.size != null && bytes !== file.size) {
            throw new Error(`Size mismatch: expected ${file.size}, got ${bytes} bytes`);
          }
          await fs.promises.rename(tmpPath, localPath);
          debugLog('import:file', `Saved: ${objectName}/${destRel} (${(bytes / 1024).toFixed(0)} KB)`);
          fileCount++;
          importStatus.filesDone++;
          importStatus.currentObjectFilesDone++;
          importStatus.bytesDone += bytes;
          importNewFiles.push({ name: `${objectName}/${destRel}`, size: bytes });
          importBytesNew += bytes;
          recordFile(file, bytes);
          // A device sidecar carries the authoritative record of the run that
          // produced these frames. Parsed here, once the file is on disk.
          if (isCaptureInfoSidecar(file.localName)) {
            ingestCaptureInfoFile(
              objIdNormalized,
              `${objFolderName}/${destRel}`,
              file.sessionFolder ?? '',
              file.date,
            );
          }

          if (/\.f(?:it|its|ts)$/i.test(localPath)) {
            thumbnailQueue.push(localPath);
          }

          if (file.date) {
            sessionSet.add(file.date);
          } else if (/\.jpe?g$/i.test(file.localName)) {
            // Streamed copies never held the bytes in memory — read the EXIF
            // date back off disk instead of a Buffer we don't have.
            const d = exifDateFromFile(localPath);
            if (d) sessionSet.add(d);
          }
        } catch (err) {
          if (tmpPath) {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          }
          downloadErrors++;
          const reason = err instanceof Error ? err.message : String(err);
          if (!firstDownloadError) firstDownloadError = reason;
          debugLog('import:error', `Download failed: ${objectName}/${file.localName} — ${reason}`);
          console.error(`Download failed: ${file.localName}:`, reason);
          importStatus.filesDone++;
          importStatus.currentObjectFilesDone++;
          importStatus.bytesDone += file.size || 0;
        }
      };

      // Fetch with concurrency 2 within each object. Constant, not
      // configurable: SeeStar's SMB server is weak and chokes on more
      // parallel requests than that.
      const DOWNLOAD_CONCURRENCY = 2;
      const downloadQueue = allFiles.slice();
      await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
        while (downloadQueue.length > 0) {
          if (importCancelRequested) { downloadsCancelled = true; break; }
          const file = downloadQueue.shift();
          if (!file) break;
          await downloadOne(file);
        }
      }));
      thumbnailQueue.close();
      await thumbnailQueue.drain();

      if (downloadsCancelled) {
        importStatus.error = 'Import cancelled. Files already downloaded were kept; the rest will be picked up on the next run.';
        importStatus.cancelled = true;
      }

      if (downloadErrors > 0) {
        // Surface the actual reason (e.g. the SMB status) instead of a generic
        // "is it reachable" line, which masks protocol-level failures.
        const detail = firstDownloadError ? ` (${firstDownloadError})` : '';
        const msg = `${downloadErrors} file(s) failed to download for ${objectName}${detail}.`;
        importStatus.error = importStatus.error ? `${importStatus.error}; ${msg}` : msg;
      }

      // Also count existing local files not in SMB allFiles list
      // (e.g. from previous imports with different settings)
      try {
        // Layout-aware: a nested object's files live one level down. Dot-prefixed
        // entries are Nebulis bookkeeping (.thumbs, the per-file manifest) and
        // are excluded by listObjectFiles, so they never inflate fileCount.
        const existingLocal = listObjectFiles(objLocalDir, objectLayout);
        const identity = resolverFor(objIdNormalized);
        for (const entry of existingLocal) {
          const night = identity.session(entry.relPath);
          if (night) {
            sessionSet.add(night);
          } else if (/\.jpe?g$/i.test(entry.fileName)) {
            const d = exifDateFromFile(path.join(objLocalDir, entry.relPath));
            if (d) sessionSet.add(d);
          }
        }
        fileCount = existingLocal.length;
      } catch { /* ignore */ }

      index.objects[objIdNormalized] = {
        folderName: existingSmbFolderName || newObjectFolderName,
        sessions: Array.from(sessionSet).sort(),
        fileCount,
        lastImport: new Date().toISOString(),
      };

      // Gallery image intentionally left null — the library card falls back
      // to the shared catalog cache (`/api/catalog/:id/image`), which is
      // populated by the "Offline Catalog Data" download in Settings.

      touchedObjectIds.add(objIdNormalized);

      // Save this object to SQLite immediately so files aren't orphaned if the
      // server crashes before the end-of-loop saveIndex() call.
      const objId = objIdNormalized;
      const objMeta = index.objects[objId];
      try {
        db.transaction(() => {
          const cat = resolveCatalogMeta(objId);
          stmts.upsertObject.run(
            objId, objMeta.folderName, objMeta.fileCount, objMeta.lastImport,
            objMeta.deleted ? 1 : 0, objMeta.deletedAt || null,
            cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
            cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy
          );
          // First-to-import-wins on the per-object color/attribution. A later
          // import from a different profile won't overwrite this — the user
          // can use Settings → Telescope → Move to consciously transfer
          // ownership when replacing hardware.
          stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, objId);
          // Stamp the on-disk shape onto the object row. This has to come after
          // the upsert above — setObjectLayout is an UPDATE, and running it
          // before the row exists silently does nothing, leaving every read
          // path listing a nested object as if it were flat.
          if (objectLayout === 'nested' || getObjectLayout(objId) !== 'nested') {
            setObjectLayout(objId, objectLayout);
          }
          // Don't clearSessions here. Existing rows for this object that
          // belong to other profiles must be preserved. The upsert below
          // adds new dates and the COALESCE inside addSessionStamped keeps
          // attribution stable on already-stamped dates.
          for (const date of objMeta.sessions) {
            stmts.addSessionStamped.run(objId, date, profile.id);
          }
        })();
      } catch (saveErr) {
        console.error(`[import] Failed to save index for ${objectName}:`, saveErr instanceof Error ? saveErr.message : saveErr);
      }

      // Audit trail: one row per object per import run. Lets the server
      // dedup later imports by (telescopeId, remotePath) and answer
      // "why did I get a duplicate?" debugging questions.
      try {
        const remotePath = walkerBase ? `${walkerBase}/${objectName}` : objectName;
        const newForObject = importNewFiles.filter(f => f.name.startsWith(`${objectName}/`)).length;
        const outcome = downloadErrors > 0 ? 'failed' : (newForObject > 0 ? 'imported' : 'skipped');
        const message = downloadErrors > 0
          ? `${downloadErrors} file(s) failed`
          : newForObject > 0
            ? `${newForObject} new file(s)`
            : 'no new files';
        for (const sessionDate of objMeta.sessions) {
          stmts.insertSessionImportLog.run(
            profile.id, remotePath, new Date().toISOString(),
            objId, sessionDate, outcome, message, runDeviceId,
          );
        }
      } catch { /* best-effort */ }

      // Mirror the rows next to the files so this object can be rebuilt
      // without the database. Best-effort by design (see writeObjectManifest).
      writeObjectManifest(objId, objFolderName);

      importStatus.objectsDone++;
    }

    // Each object was already saved to DB inside the per-object transaction
    // above. Only the meta timestamp remains. Calling saveIndex(index, ...) here
    // would re-assert the snapshot loaded at import start for every library
    // object, including ones not touched by this run — resurrecting sessions
    // deleted while the import was running and overwriting folderNames changed
    // by concurrent moves.
    const lastImportTs = new Date().toISOString();
    try {
      stmts.updateMetaLastImport.run(lastImportTs);
    } catch (err) {
      console.warn('[import] updateMetaLastImport failed:', err instanceof Error ? err.message : err);
    }
    importStatus.lastRun = lastImportTs;

    // Enrich with Wikipedia description + SIMBAD size data, and backfill
    // historical weather for sessions missing it. Both are best-effort
    // network calls; enrichObjectData internally checks whether the object
    // is already fully enriched and returns immediately if so.
    for (const objectId of touchedObjectIds) {
      try {
        debugLog('import:object', `${objectId}: enriching catalog data`);
        await enrichObjectData(objectId);
        debugLog('import:object', `${objectId}: enrichment complete`);
      } catch {
        debugLog('import:object', `${objectId}: enrichment failed (non-fatal)`);
      }
      try {
        debugLog('import:object', `${objectId}: backfilling weather`);
        await backfillSessionWeather(objectId);
        debugLog('import:object', `${objectId}: weather backfill complete`);
      } catch (err) {
        console.warn(`[import] Weather backfill failed for "${objectId}":`, err instanceof Error ? err.message : err);
        debugLog('import:object', `${objectId}: weather backfill failed — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Pre-warm the gallery thumbnail cache for every object that received new
    // files so the library grid loads instantly on first view.
    if (importNewFiles.length > 0) {
      const newObjectIds = new Set(importNewFiles.map(f => normalizeObjectId(f.name.split('/')[0])));
      debugLog('import:thumb', `Pre-warming gallery thumbnails for ${newObjectIds.size} object(s): ${Array.from(newObjectIds).join(', ')}`);
      await pregenerateObjectThumbnails(newObjectIds);
      debugLog('import:thumb', 'Gallery thumbnail pre-warm complete');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    debugLog('import:error', `Fatal: ${reason}`);
    // Also log at normal level: previously a fatal import failure was only
    // captured via debugLog (off by default) and importStatus.error, so a user
    // whose import silently pulled nothing saw no error in the log at all until
    // they enabled debug logging.
    log.error(
      {
        telescopeId: profile.id,
        telescopeName: profile.name,
        transport: profile.connectionType ?? 'smb',
        address: transportAddress,
        err: reason,
      },
      '[import] Import from %s failed: %s', profile.name, reason,
    );
    importStatus.error = friendlyImportError(err, profile);
  } finally {
    importStatus.skipped = summarizeSkips(importSkips);
    debugLog('import:done', `Finished — objects: ${importStatus.objectsDone}/${importStatus.objectsTotal}, new files: ${importNewFiles.length}, bytes: ${importBytesNew}${importStatus.error ? ` | error: ${importStatus.error}` : ''}`);
    // Logged at info level, not just debug: "the import pulled fewer files than
    // are on my telescope" is the single most common confusion, and the answer
    // should be in the normal log rather than behind a debug flag.
    if (importStatus.skipped.length > 0) {
      const total = importStatus.skipped.reduce((n, s) => n + s.count, 0);
      log.info(
        { telescopeId: importStatus.telescopeId, telescopeName: importStatus.telescopeName, skipped: importStatus.skipped },
        '[import] Left out %d file(s): %s',
        total,
        importStatus.skipped.map(s => `${s.count} ${s.label}`).join('; '),
      );
    }
    // Save history record
    try {
      stmts.insertHistory.run(
        importStatus.startedAt,
        new Date().toISOString(),
        importStatus.objectsTotal,
        importStatus.filesTotal,
        importNewFiles.length,
        importStatus.bytesTotal,
        importBytesNew,
        importStatus.error || null,
        importNewFiles.length > 0 ? JSON.stringify(importNewFiles.map(f => f.name)) : null,
        importStatus.telescopeId,
        importStatus.telescopeName,
        importStatus.transportKind,
        importStatus.skipped.length > 0 ? JSON.stringify(importStatus.skipped) : null,
        importStatus.manual ? 1 : 0,
        importStatus.cancelled ? 1 : 0,
      );
    } catch (err) {
      console.warn('[import] insertHistory failed:', err instanceof Error ? err.message : err);
    }
    // New images may have landed; drop the gallery walk cache so they appear
    // on the next /all-images call instead of waiting out the TTL.
    if (importNewFiles.length > 0) invalidateAllImagesCache();
    importStatus.running = false;
    importStatus.currentObject = null;
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    currentImportProfile = null;
    try { stmts.setImportRunning.run(0, null); } catch (err) {
      console.warn('[import] setImportRunning failed:', err instanceof Error ? err.message : err);
    }
  }
  } finally {
    releaseImportLock();
  }
}

/**
 * Sync only raw sub-frame (.fit/.fits) files for a specific session from the
 * telescope's _sub companion folder. Strictly filters by date so no files from
 * other sessions bleed through. Skips files already present locally.
 */
export async function syncSessionSubFrames(
  targetObjectId: string,
  targetDate: string,
  options?: RunImportOptions,
): Promise<void> {
  // Outer try/finally: same reasoning as runImport's — resolveCanonicalId,
  // getProfileById, and selectActiveTransport below all ran unguarded before
  // the inner try, so a throw there leaked the lock permanently.
  // releaseImportLock() is idempotent, so this layers over the existing
  // release paths below rather than replacing them.
  try {
  // Resolve aliases so "C63" and "NGC7293" always land on the same objectId,
  // matching runImport (import.ts:421). Also strip spaces so the id matches
  // the DB primary key convention (normalizeObjectId) before any lookup below.
  targetObjectId = resolveCanonicalId(normalizeObjectId(targetObjectId));
  // Look up the telescope first so we can stamp its name onto importStatus
  // even on the early-return error paths below.
  const baseProfile = options?.telescopeId ? getProfileById(options.telescopeId) : null;

  // Mirror runImport: select the active transport (USB wins over SMB when present)
  // so sub-frame sync uses the same connection as a regular import would.
  const activeTransport = baseProfile ? selectActiveTransport(baseProfile.id) : null;
  const profile: TelescopeProfile | null = baseProfile && activeTransport
    ? {
        ...baseProfile,
        connectionType: activeTransport.kind,
        hostname: activeTransport.hostname,
        shareName: activeTransport.shareName,
        username: activeTransport.username,
        password: activeTransport.password,
        localPath: activeTransport.localPath,
      }
    : baseProfile;

  // Lock is managed by claimImportLock() — callers must acquire it first
  importCancelRequested = false;
  importStatus = {
    running: true,
    runId: randomUUID(),
    currentObject: targetObjectId,
    telescopeId: profile?.id ?? null,
    telescopeName: profile?.name ?? null,
    transportKind: activeTransport ? activeTransport.kind : (profile?.connectionType ?? null),
    objectsTotal: 1,
    objectsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    currentObjectFilesTotal: 0,
    currentObjectFilesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    skippedFiles: 0,
    // A sub-frame sync asks for one session's raw frames by date. Everything it
    // passes over is out because the caller narrowed the request, not because a
    // filter dropped it, so there is nothing here to explain.
    skipped: [],
    lastRun: importStatus.lastRun,
    error: null,
    cancelled: false,
    startedAt: new Date().toISOString(),
    warmingThumbnails: null,
    // Always explicit: a sub-frame sync is only ever fired from a
    // user-initiated route, never the scheduler.
    manual: true,
  };

  // Local-fs profiles (Dwarf USB) have no hostname; require localPath instead.
  const transportAddress = profile?.connectionType === 'local' ? profile.localPath : profile?.hostname;
  if (!profile || !transportAddress) {
    importStatus.error = profile
      ? (profile.connectionType === 'local'
        ? `"${profile.name}" is set to USB mode but no local path is configured. Open Settings, Hardware, ${profile.name}, and set the path to your telescope's storage.`
        : `"${profile.name}" has no hostname configured. Open Settings, Hardware, ${profile.name}, and enter the telescope's IP address or hostname.`)
      : 'No telescope was selected for this sync. Open Settings, Hardware, and pick the telescope you want to pull from.';
    importStatus.running = false;
    importStatus.telescopeId = profile?.id ?? null;
    importStatus.telescopeName = profile?.name ?? null;
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
    return;
  }
  currentImportProfile = profile;
  currentImportWalker = getWalkerConfig(profile.kind);
  const walkerBase = currentImportWalker.basePath;
  const isDwarf = isDwarfKind(profile.kind);
  // Existing objects keep whatever shape they were imported with (see
  // libraryLayout.ts) — this sync must land files in the same shape runImport
  // would have used, or a nested object ends up with sub-frames scattered at
  // its root alongside the per-session folders the rest of its files live in.
  const objectLayout = getObjectLayout(targetObjectId);

  log.info(
    {
      telescopeId: profile.id,
      telescopeName: profile.name,
      kind: profile.kind,
      transport: profile.connectionType ?? 'smb',
      address: transportAddress,
      objectId: targetObjectId,
      date: targetDate,
    },
    '[subframe-sync] Starting sub-frame sync for %s session %s from %s (%s) at %s',
    targetObjectId, targetDate, profile.name, profile.kind, transportAddress,
  );

  debugLog('subframe-sync:start', `Telescope: "${profile.name}" (${profile.kind}) | Address: ${transportAddress} | Object: ${targetObjectId} | Date: ${targetDate} | Walker base: ${walkerBase}`);

  try {
  ensureLibraryDir();
  const index = loadIndex();

    // Never re-import tombstoned sessions (strict policy) — matches runImport's
    // deletedSessions check (import.ts:1078). Without this, syncing sub-frames
    // for a deleted session silently resurrects it.
    if (index.objects[targetObjectId]?.deletedSessions?.includes(targetDate)) {
      importStatus.error = `The ${targetDate} session for "${targetObjectId}" was deleted and cannot be re-synced. Delete it again after syncing if this was unintentional.`;
      return;
    }

    // Vendor-specific candidate discovery → unified { remotePath, localName, size }.
    interface SubFrameCandidate {
      remotePath: string;
      localName: string;
      originalName: string;
      size?: number;
      /** Session directory inside the object folder, for a nested object.
       *  null puts the file at object level, matching a flat object. */
      sessionFolder: string | null;
    }
    let candidates: SubFrameCandidate[] = [];

    if (isDwarf) {
      // Dwarf has no _sub companion folder. Subframes are the numbered files
      // (001-..., 002-...) sitting next to the rolling stack inside each
      // session folder. Match session folders by target name and by the
      // session date encoded in the folder name.
      debugLog('subframe-sync:discover', `Dwarf: scanning for sub-frames of "${targetObjectId}" on ${targetDate}`);
      const discovered = await discoverDwarfObjects(profile);
      // Resolve aliases the same way runImport does (import.ts's toImport
      // filter): the device's own folder name is a raw target string (e.g.
      // "C 5"), which may differ from the canonical id this sync was asked
      // for (e.g. "IC342") once catalog aliasing is applied. Without this,
      // sub-frame sync for any object whose canonical id differs from its
      // device folder name silently found no match and synced nothing.
      const obj = discovered.find(o => resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId);
      if (!obj) {
        debugLog('subframe-sync:discover', `Dwarf: no session folder found for "${targetObjectId}"`);
        importStatus.error = `${profile.name} has no Dwarf session folders for "${targetObjectId}". Capture the object on the telescope first, then sync.`;
        return;
      }
      // Audit 1.44: include folders whose own encoded date matches targetDate
      // PLUS any folder containing files whose own timestamp matches
      // targetDate. Multi-night sessions that span UTC midnight live inside a
      // folder named for night N-1 but emit files timestamped N — filtering by
      // folder name alone misses them. We do a broader scan and then re-filter
      // each candidate file by its own parsed date.
      const allFolders = obj._dwarfSessionFolders ?? [];
      debugLog('subframe-sync:discover', `Dwarf: ${allFolders.length} total session folder(s) for "${targetObjectId}", filtering for date ±1 day of ${targetDate}`);
      // Heuristic: keep folders dated targetDate, plus folders dated targetDate
      // minus or plus one day (sessions spanning UTC midnight). Falling back
      // to "all folders for this object" would scale badly on heavy users.
      const targetMs = Date.parse(targetDate + 'T00:00:00Z');
      const folderCandidates = allFolders.filter(name => {
        const fd = extractDateFromSessionFolder(name);
        if (!fd) return false;
        if (fd === targetDate) return true;
        const folderMs = Date.parse(fd + 'T00:00:00Z');
        if (Number.isNaN(folderMs) || Number.isNaN(targetMs)) return false;
        const dayDiff = Math.abs(folderMs - targetMs) / 86_400_000;
        return dayDiff <= 1;
      });
      debugLog('subframe-sync:discover', `Dwarf: ${folderCandidates.length} candidate folder(s) matching date range: ${folderCandidates.join(', ')}`);
      if (folderCandidates.length === 0) {
        importStatus.error = `${profile.name} has no Dwarf session folder for "${targetObjectId}" on ${targetDate}. Confirm the date matches one of the captured sessions.`;
        return;
      }
      const { subFiles } = await listDwarfObjectFiles(profile, {
        folderName: obj.folderName,
        subFolderName: null,
        _dwarfSessionFolders: folderCandidates,
      });
      debugLog('subframe-sync:discover', `Dwarf: ${subFiles.length} sub-file(s) found across candidate folders`);
      const mapped: Array<SubFrameCandidate | null> = subFiles
        .filter(e => /\.f(?:it|its|ts)$/i.test(e.name))
        .map(e => {
          const slash = e.name.indexOf('/');
          const sessionFolder = slash >= 0 ? e.name.slice(0, slash) : '';
          const basename = slash >= 0 ? e.name.slice(slash + 1) : e.name;

          if (objectLayout === 'nested') {
            // Mirror runImport's nested-Dwarf branch (import.ts, toImportFile
            // above): keep the device's own basename and mirror its session
            // folder instead of renaming through dwarfLocalName, which is a
            // flat-layout naming scheme. Using the renamed form here would
            // save a second, differently-named copy of the same frame at the
            // object root instead of inside the session folder the rest of
            // this object's files already live in.
            if (!isSafeRemoteFileName(basename)) return null;
            // No per-file date re-derivation here, matching runImport's own
            // nested-Dwarf branch: the renamed, parse-friendly name that
            // would let sessionNightFor look at the file's own embedded time
            // only exists on the flat-layout path below.
            const night = dwarfFolderNightDate(sessionFolder);
            if (night !== targetDate) return null;
            const sessionDir = sessionFolderFor(sessionFolder || null, night, null);
            if (!sessionDir) return null;
            return {
              remotePath: buildDwarfFilePath(e.name),
              localName: basename,
              originalName: basename,
              size: e.size,
              sessionFolder: sessionDir,
            };
          }

          // After dwarfLocalName, the file parses cleanly. Filter by the file's
          // own embedded date rolled to its observing night, not the folder's
          // raw date, so cross-midnight captures are assigned to the night
          // they were actually exposed.
          const named = dwarfLocalName(basename, sessionFolder);
          // No skip tally here: this path syncs one session's raw frames on
          // explicit request, so anything it cannot name is reported through the
          // sync modal's own error/empty state rather than a run-wide summary.
          if (named.name === null) return null;
          const night = sessionNightFor(parseFilename(named.name));
          if (night !== targetDate) return null;
          return {
            remotePath: buildDwarfFilePath(e.name),
            localName: named.name,
            originalName: basename,
            size: e.size,
            sessionFolder: null,
          };
        });
      candidates = mapped.filter((c): c is SubFrameCandidate => c !== null);
      debugLog('subframe-sync:discover', `Dwarf: ${candidates.length} sub-frame candidate(s) after date filtering`);
    } else {
      debugLog('subframe-sync:discover', `SeeStar: listing ${walkerBase} for sub-frame folders`);
      const entries = await smbListDir(walkerBase, profile);
      const subFolders = entries.filter(e => e.type === 'dir' && isSubFolder(e.name));
      debugLog('subframe-sync:discover', `SeeStar: ${subFolders.length} sub-folder(s) found`);
      const subFolder = subFolders.find(s => normalizeObjectId(getObjectFromSubFolder(s.name)) === targetObjectId);
      if (!subFolder) {
        debugLog('subframe-sync:discover', `SeeStar: no sub-frame folder for "${targetObjectId}"`);
        importStatus.error = `${profile.name} has no sub-frame folder for "${targetObjectId}". The telescope only keeps sub-frames for sessions where you enabled that option.`;
        return;
      }
      const smbSubPath = walkerBase ? `${walkerBase}/${subFolder.name}` : subFolder.name;
      debugLog('subframe-sync:discover', `SeeStar: listing sub-frames from ${smbSubPath}`);
      const subEntries = await smbListDir(smbSubPath, profile);
      const rawSubFiles = subEntries.filter(e => e.type === 'file' && isSafeRemoteFileName(e.name));
      debugLog('subframe-sync:discover', `SeeStar: ${rawSubFiles.length} file(s) in ${subFolder.name}`);
      candidates = rawSubFiles
        .filter(e => {
          if (e.type !== 'file') return false;
          if (!/\.f(?:it|its|ts)$/i.test(e.name)) return false;
          return sessionNightFor(parseFilename(e.name)) === targetDate;
        })
        .map(e => ({
          remotePath: `${smbSubPath}/${e.name}`,
          localName: e.name,
          originalName: e.name,
          size: e.size,
          // SeeStar has no session directory of its own — mirrors runImport's
          // SeeStar branch, which synthesizes one from the file's own
          // observing night for a nested object.
          sessionFolder: objectLayout === 'nested'
            ? sessionFolderFor(null, sessionNightFor(parseFilename(e.name)), null)
            : null,
        }));
      debugLog('subframe-sync:discover', `SeeStar: ${candidates.length} sub-frame candidate(s) matching date ${targetDate}`);
    }

    const objLocalDir = safeObjectDir(getFolderName(targetObjectId));
    if (!objLocalDir) {
      importStatus.error = `Cannot sync sub-frames for "${targetObjectId}": the object's folder name is unsafe.`;
      return;
    }
    if (!fs.existsSync(objLocalDir)) {
      fs.mkdirSync(objLocalDir, { recursive: true });
    }

    /** Object-relative destination for a file: `<session>/<name>` when nested. */
    const destRelFor = (file: SubFrameCandidate): string =>
      file.sessionFolder ? `${file.sessionFolder}/${file.localName}` : file.localName;

    // Only count files that actually need downloading. Already-present files
    // would otherwise be swept through synchronously before the client's first
    // status poll, making the progress bar open halfway full.
    const toDownload = candidates.filter(f => !fs.existsSync(path.join(objLocalDir, destRelFor(f))));
    importStatus.filesTotal = toDownload.length;
    importStatus.skippedFiles = candidates.length - toDownload.length;
    debugLog('subframe-sync:files', `${toDownload.length} file(s) to download, ${importStatus.skippedFiles} already present`);

    let downloadErrors = 0;
    const downloadedPaths: string[] = [];
    for (const file of toDownload) {
      if (importCancelRequested) {
        importStatus.error = 'Sub-frame sync cancelled. Files already downloaded were kept; the rest will be picked up on the next run.';
        importStatus.cancelled = true;
        return;
      }
      const destRel = destRelFor(file);
      const localPath = path.join(objLocalDir, destRel);
      const objRoot = path.resolve(objLocalDir);
      const tmpPath = `${localPath}.tmp`;
      try {
        if (localPath !== objRoot && !localPath.startsWith(objRoot + path.sep)) {
          throw new Error(`Refusing to write outside object directory: ${destRel}`);
        }
        debugLog('subframe-sync:file', `Downloading: ${file.localName}${file.size != null ? ` (${(file.size / 1024).toFixed(0)} KB)` : ''}`);
        const data = await smbGetFile(file.remotePath, undefined, profile);
        if (file.size != null && data.length !== file.size) {
          throw new Error(`Size mismatch: expected ${file.size}, got ${data.length} bytes`);
        }
        // Nested files land in a per-session directory that may not exist yet.
        if (file.sessionFolder) {
          await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
        }
        // Async write + rename so a large sub-frame doesn't block the event loop.
        await fs.promises.writeFile(tmpPath, data);
        await fs.promises.rename(tmpPath, localPath);
        downloadedPaths.push(localPath);
        debugLog('subframe-sync:file', `Saved: ${file.localName} (${(data.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        downloadErrors++;
        const reason = err instanceof Error ? err.message : String(err);
        debugLog('subframe-sync:error', `Download failed: ${file.localName} — ${reason}`);
        console.error('Sub-frame download failed: %s:', file.localName, reason);
      }
      importStatus.filesDone++;
    }

    // Generate JPEG thumbnails for newly downloaded FITS subframes so the UI
    // can show small previews without downloading the full file each time.
    for (const localPath of downloadedPaths) {
      if (!/\.f(?:it|its|ts)$/i.test(localPath)) continue;
      await generateFitsThumbnail(localPath).catch(err =>
        console.warn(`[thumb] ${path.basename(localPath)}:`, err instanceof Error ? err.message : err),
      );
    }

    if (downloadErrors > 0) {
      importStatus.error = `${downloadErrors} of ${toDownload.length} sub-frame downloads failed. Check that ${profile.name} stayed reachable and try the sync again.`;
    }

    // Record every candidate that is on disk, not just the ones downloaded on
    // this run, so a re-sync gives rows to sub-frames pulled down before this
    // table existed. Roles are 'sub' by construction: this whole path only
    // ever handles raw frames.
    {
      const objFolderName = path.basename(objLocalDir);
      for (const file of candidates) {
        const localPath = path.join(objLocalDir, destRelFor(file));
        let bytes = file.size ?? 0;
        if (!fs.existsSync(localPath)) continue;
        if (!bytes) {
          try { bytes = fs.statSync(localPath).size; } catch { /* best effort */ }
        }
        const parsed = parseFilename(file.localName);
        recordLibraryFile({
          objectId: targetObjectId,
          folderName: objFolderName,
          sessionFolder: file.sessionFolder,
          fileName: file.localName,
          originalName: file.originalName,
          role: 'sub',
          captureDate: parsed.date ?? null,
          captureTime: parsed.timestamp ? parsed.timestamp.slice(-6) : null,
          sessionDateOverride: parsed.date ? null : targetDate,
          telescopeId: profile.id,
          bytes,
          sourcePath: file.remotePath,
        });
      }
      writeObjectManifest(targetObjectId, objFolderName);
    }

    // Refresh index entry — create one if this is the first sync for this object
    const existing = index.objects[targetObjectId];
    const folderName = getFolderName(targetObjectId);
    const sessionSet = new Set<string>(existing?.sessions ?? []);
    sessionSet.add(targetDate);
    try {
      // Layout-aware count: a flat readdirSync undercounts a nested object,
      // whose files sit one level down in per-session directories.
      const localFiles = listObjectFiles(objLocalDir, objectLayout);
      index.objects[targetObjectId] = {
        ...(existing ?? { folderName, deletedSessions: [] }),
        folderName,
        sessions: Array.from(sessionSet).sort(),
        fileCount: localFiles.length,
        lastImport: new Date().toISOString(),
      };
    } catch { /* ignore */ }

    // Per-object write only — mirrors runImport (import.ts:940-960). Calling
    // saveIndex(index, ...) here would persist the FULL snapshot loaded at run
    // start for every object in the library, not just this one: it stamps
    // every untagged session library-wide with this telescope, claims
    // primaryTelescopeId for every unclaimed object, and re-asserts stale
    // folderNames/deleted flags/sessions for objects this run never touched.
    const objMeta = index.objects[targetObjectId];
    if (objMeta) {
      try {
        db.transaction(() => {
          const cat = resolveCatalogMeta(targetObjectId);
          stmts.upsertObject.run(
            targetObjectId, objMeta.folderName, objMeta.fileCount, objMeta.lastImport,
            objMeta.deleted ? 1 : 0, objMeta.deletedAt || null,
            cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
            cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy
          );
          stmts.setObjectPrimaryTelescopeIfNull.run(profile.id, targetObjectId);
          for (const date of objMeta.sessions) {
            stmts.addSessionStamped.run(targetObjectId, date, profile.id);
          }
          if (objMeta.deletedSessions) {
            for (const date of objMeta.deletedSessions) {
              stmts.addSessionTombstone.run(targetObjectId, date);
            }
          }
        })();
      } catch (saveErr) {
        console.error(`[subframe-sync] Failed to save index for ${targetObjectId}:`, saveErr instanceof Error ? saveErr.message : saveErr);
      }
    }
    const lastImportTs = new Date().toISOString();
    try { stmts.updateMetaLastImport.run(lastImportTs); } catch { /* best-effort */ }
    importStatus.lastRun = lastImportTs;
  } catch (err) {
    importStatus.error = friendlyImportError(err, profile);
  } finally {
    importStatus.running = false;
    importStatus.currentObject = null;
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    importStatus.objectsDone = 1;
    currentImportProfile = null;
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
  }
  } finally {
    releaseImportLock();
  }
}

/**
 * Run runImport once per auto-import-enabled telescope, sequentially.
 * Stamps each scope's sessions with its own id; lock is released between runs
 * so status reflects the most recent telescope.
 *
 * Sequential rather than parallel to keep the existing import-lock + status
 * model intact. SMB throughput is rarely the bottleneck on a home network and
 * parallel fan-out would need a per-telescope status panel — out of scope for v1.
 */
export async function runAllTelescopesImport(): Promise<void> {
  // Manual sweep: hit every non-archived telescope that has connection
  // details. Skipping the auto-import toggle here is deliberate — that
  // toggle controls the *scheduler*; a user clicking "Import Now" or
  // POSTing /library/import is explicitly asking for a sync now.
  //
  // getManualImportProfiles() is wrapped on its own: at this point the
  // caller has already claimed the lock for us, so a throw here (e.g. a DB
  // error) used to leak it permanently — nothing downstream would ever
  // release it. Once the loop below starts, ownership of the lock transfers
  // to each runImport() call (or to whichever process wins a between-
  // telescopes re-claim), so a blanket release after this point would
  // force-release a lock this function no longer owns.
  let profiles;
  try {
    profiles = getManualImportProfiles();
  } catch (err) {
    console.error('[import] getManualImportProfiles failed:', err instanceof Error ? err.message : err);
    importStatus.error = 'Failed to load telescope profiles. Check the server logs and try again.';
    releaseImportLock();
    return;
  }
  if (profiles.length === 0) {
    importStatus.error = 'No telescopes are configured yet. Add one in Settings, Hardware.';
    // Caller (route handler / scheduler) already claimed the lock — release
    // it here so subsequent imports aren't permanently blocked. Without this
    // the lock leaks and every future import returns 409 IMPORT_RUNNING.
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    releaseImportLock();
    return;
  }
  // Caller has already claimed the lock for the first profile. Each runImport
  // releases it in its finally, so re-claim before starting the next telescope.
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    if (i > 0 && !claimImportLock()) {
      const skipped = profiles.slice(i).map(p => p.name).join(', ');
      appendImportStatusError(
        `Import lock was claimed by another run before ${skipped} could be synced. They'll be picked up on the next scheduled or manual import.`,
      );
      return;
    }
    try {
      await runImport(undefined, undefined, { telescopeId: profile.id, manual: true });
      const status = getImportStatus();
      log.info(
        { telescope: profile.name, filesDone: status.filesDone, skipped: status.skippedFiles, objects: status.objectsDone, error: status.error ?? null },
        '[import] Manual import completed',
      );
    } catch (err) {
      console.error(`[import] runImport failed for ${profile.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ─── Status / history ────────────────────────────────────────────────────────

export function getImportStatus(): ImportStatus {
  return { ...importStatus };
}

export function getImportHistory(limit = 10, offset = 0): { entries: ImportHistoryEntry[]; total: number } {
  const rows = stmts.getHistory.all(limit, offset);
  const count = stmts.getHistoryCount.get()?.count ?? 0;
  // `r.files` is a JSON-serialized string[] (we wrote it via JSON.stringify).
  // Narrow it back to string[] at this boundary instead of casting via `any`.
  const parseFiles = (raw: string | null): string[] | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      return null;
    }
  };
  // Same narrowing as parseFiles: the column holds what a past version of this
  // code serialized, so validate the shape rather than trusting it. `label` is
  // re-read from SKIP_LABELS instead of the stored copy so a reworded label
  // applies to old rows too, and a reason code we no longer recognise (a
  // downgrade, a hand-edited DB) is dropped rather than rendered blank.
  const parseSkipped = (raw: string | null): ImportSkipSummary[] | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const tally: SkipTally = new Map();
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { reason, count, bytes } = entry as { reason?: unknown; count?: unknown; bytes?: unknown };
        if (typeof reason !== 'string' || typeof count !== 'number') continue;
        if (!(reason in SKIP_LABELS)) continue;
        // History rows written before sizes were tallied have no `bytes`; 0 reads
        // as "not measured" and the UI omits the size rather than showing "0 B".
        countSkip(tally, reason as ImportSkipReason, count, typeof bytes === 'number' ? bytes : 0);
      }
      const summary = summarizeSkips(tally);
      return summary.length > 0 ? summary : null;
    } catch {
      return null;
    }
  };
  return {
    entries: rows.map(r => ({
      ...r,
      files: parseFiles(r.files),
      skipped: parseSkipped(r.skipped),
      manual: r.manual === 1,
      cancelled: r.cancelled === 1,
    })),
    total: count,
  };
}

/**
 * Atomically claim the import lock. Returns true if the lock was acquired,
 * false if an import is already running. Callers must use this before calling
 * runImport / syncSessionSubFrames to prevent the TOCTOU race where two
 * requests both see running===false.
 */
export function claimImportLock(): boolean {
  if (importStatus.running) return false;
  importStatus.running = true;
  try { stmts.setImportRunning.run(1, new Date().toISOString()); } catch { /* best-effort */ }
  return true;
}

/**
 * Release the import lock without running an import. Used by callers that
 * claimed the lock but run a synchronous operation (e.g. drag-and-drop upload)
 * rather than an async import function that releases in its own finally block.
 */
export function releaseImportLock(): void {
  importStatus.running = false;
  try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
}

/**
 * Force-release the import lock when it has been held far longer than any
 * real import should take. Insurance against a lock-leak path this module
 * doesn't already guard against (a genuinely hung SMB call, an unhandled
 * rejection outside every try/finally here) — see the watchdog in
 * housekeeping.ts's auto-import tick. Sets a loud, visible error so whoever
 * looks at the import status understands why their in-progress run vanished.
 */
export function forceReleaseStaleLock(reason: string): void {
  console.error(`[import] ${reason}`);
  importStatus.error = reason;
  releaseImportLock();
}

/**
 * When the lock was claimed, per the DB row claimImportLock() writes
 * atomically alongside importRunning. Used by the stale-lock watchdog
 * instead of importStatus.startedAt: the in-memory field isn't set until a
 * run function does its full status reset partway through (after profile/
 * transport validation), so a hang before that point would leave it holding
 * a stale value from whatever run completed previously.
 */
export function getImportLockStartedAt(): string | null {
  try {
    return stmts.getImportMeta.get()?.importStartedAt ?? null;
  } catch {
    return null;
  }
}

/**
 * Append a message to importStatus.error without clearing existing progress
 * state. Used when a multi-telescope sweep (runAllTelescopesImport,
 * housekeeping's runDueTelescopesImport) has to give up on the remaining
 * telescopes because a between-telescopes lock re-claim lost a race —
 * earlier telescopes in the same sweep may have already completed
 * successfully, so a full overwrite of importStatus would erase their result.
 */
export function appendImportStatusError(message: string): void {
  console.warn(`[import] ${message}`);
  importStatus.error = importStatus.error ? `${importStatus.error}; ${message}` : message;
}

// ─── Folder-import wizard: commit (phase 2) ──────────────────────────────────

/** Default final date for a derived session: the file's own observing night
 *  (see `observingNightDate` — this must match how `summarizeSessions` bucketed
 *  it during scan, so the sessionMap keys line up), except the unsorted bucket
 *  which is dropped unless the user assigned it a date. */
function resolveTargetDate(
  sessionMap: Record<string, string | null>,
  derivedDate: string | null,
  derivedTime: string | null,
): string | null {
  const night = derivedDate ? observingNightDate(derivedDate, derivedTime) : null;
  const key = night ?? UNSORTED_KEY;
  if (Object.prototype.hasOwnProperty.call(sessionMap, key)) {
    return sessionMap[key];
  }
  return night; // null for unsorted → dropped by default
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Phase 2 of the folder-import wizard: apply the user-reviewed plan.
 *
 * The plan carries only decisions (object → catalog mapping, per-session final
 * dates, skips). The folder is re-walked here and dates are re-derived exactly
 * as the scan did, so the client's paths are never trusted and scan/commit
 * can't drift. Files are copied into the library, renamed when needed so the
 * read path reproduces the assigned session date, then libraryObjects /
 * librarySessions are written via the shared saveIndex (which also runs catalog
 * enrichment), and weather is backfilled.
 *
 * Callers must claim the import lock first (the route does).
 */
export async function commitFolderImport(plan: CommitPlan): Promise<void> {
  if (!importStatus.running) {
    if (!claimImportLock()) return;
  }

  // Outer try/finally: by this point we (the caller, or the claim above)
  // hold the lock unconditionally for the rest of this call. Everything
  // below — including ensureLibraryDir/loadSettings/loadIndex, which ran
  // unguarded before the inner try — used to leak the lock on a throw, and
  // the inner finally below only ever reset importStatus.running in memory,
  // never persisting the release via setImportRunning, so a restart right
  // after a normal commit would wrongly report an interrupted import.
  // releaseImportLock() is idempotent, so this layers over (and fixes) the
  // existing release paths rather than conflicting with them.
  try {
  const rootPath = plan.rootPath;
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    importStatus.running = false;
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
    throw new Error(`The path "${rootPath}" is not a folder the server can read.`);
  }

  // Whether this import reads from the wizard's upload staging area rather
  // than a folder of the user's own. Staged files are ours to delete: the copy
  // loop drops each one as soon as it has landed in the library, so a large
  // upload no longer needs room for two full copies at once. An in-place
  // import must obviously never touch its source.
  const stagedSource = isStagedPath(plan.rootPath);

  const prevLastRun = importStatus.lastRun;
  const commitProfile = plan.telescopeId ? getProfileById(plan.telescopeId) : null;
  importCancelRequested = false;
  importStatus = {
    running: true,
    runId: randomUUID(),
    currentObject: null,
    telescopeId: commitProfile?.id ?? null,
    telescopeName: commitProfile?.name ?? null,
    transportKind: null,
    objectsTotal: 0,
    objectsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    currentObjectFilesTotal: 0,
    currentObjectFilesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    skippedFiles: 0,
    skipped: [],
    lastRun: prevLastRun,
    error: null,
    cancelled: false,
    startedAt: new Date().toISOString(),
    warmingThumbnails: null,
    // Always explicit: a folder import is only ever fired from the
    // user-driven commit wizard, never the scheduler.
    manual: true,
  };
  importNewFiles = [];
  importBytesNew = 0;
  importSkips = new Map();

  ensureLibraryDir();
  const baseSettings = loadSettings();
  const overrides: Record<string, unknown> = {};
  if (plan.importSubFrames !== undefined) overrides.importSubFrames = plan.importSubFrames;
  if (plan.importFits !== undefined) overrides.importFits = plan.importFits;
  if (plan.archiveAllFiles !== undefined) overrides.archiveAllFiles = plan.archiveAllFiles;
  const settings = Object.keys(overrides).length > 0
    ? { ...baseSettings, ...overrides }
    : baseSettings;
  const index = loadIndex();

  log.info(
    { rootPath, objects: plan.objects.length, importFits: settings.importFits, importSubFrames: settings.importSubFrames },
    '[folder-import] starting',
  );
  debugLog('import:folder-commit',
    `Manual folder import: ${rootPath}  |  ${plan.objects.filter(o => !o.skip).length} object(s) to import` +
    `${plan.telescopeId ? ` | assigned telescope: ${plan.telescopeId}` : ''}`);
  debugLog('import:folder-commit',
    `Effective settings → JPG:${settings.importJpg !== false} FITS:${settings.importFits !== false} ` +
    `Archive-all:${settings.archiveAllFiles === true} ` +
    `Thumbs:${settings.importThumbnails !== false} Subs:${settings.importSubFrames === true} ` +
    `Video:${settings.importVideos === true}`);

  try {
    // Non-observation folders (CALI_FRAME, RESTACKED, ...) are dropped inside
    // collectObjectSources, so commit and the scan agree without this call site
    // needing to know the rule. The excluded names are only needed for the
    // scan's user-facing report. Passing the same telescopeKind the scan used
    // (resolved from plan.telescopeId, exactly as the scan resolves it from
    // the request's telescopeId) keeps the vendor-base-path descent agreeing
    // between the two phases too.
    const { sources } = collectObjectSources(rootPath, commitProfile?.kind);
    const planByFolder = new Map<string, CommitObjectPlan>();
    for (const p of plan.objects) planByFolder.set(p.folderName, p);

    const active = sources.filter(s => {
      const p = planByFolder.get(s.folderName);
      return p && !p.skip;
    });
    importStatus.objectsTotal = active.length;

    // When two source folders map to the same library object, they must land
    // in the same on-disk folder. First mapping wins the folder name.
    const dirByObjectId = new Map<string, string>();
    const folderNameByObjectId = new Map<string, string>();
    // Session dates this run actually copied a new file for, per object. Used
    // below to scope telescope attribution to sessions this import created —
    // reconciling from disk pulls in every date already on disk for the
    // object, including sessions from earlier imports before any telescope
    // was known, and those must stay untagged.
    const importedDatesByObjectId = new Map<string, Set<string>>();
    /** Shape each object was written with, stamped onto its row after the
     *  upsert below. setObjectLayout is an UPDATE, so doing it earlier (before
     *  the row exists) silently no-ops and leaves a nested folder read as flat. */
    const layoutByObjectId = new Map<string, LibraryLayout>();

    // Pre-walk every selected source before copying anything. This is the same
    // total work as walking inside the loop below (one walk per source), moved
    // earlier so the import knows its full size up front. Two things need
    // that: the free-space preflight, which has to run before the first write
    // rather than discovering ENOSPC halfway through; and the progress bar,
    // which used to watch filesTotal climb as objects were reached.
    //
    // The walk's own tally is carried through to importStatus rather than
    // discarded: the scan reported the same counts before the user confirmed,
    // but the commit runs with the plan's per-import importFits /
    // importSubFrames overrides, so the two can legitimately differ and the
    // commit's numbers are the ones that describe what actually landed.
    const walkedBySource = new Map<ObjectSource, WalkedFile[]>();
    let plannedBytes = 0;
    let largestFileBytes = 0;
    // scanImportFolder surfaces this same per-object cap (MAX_FILES_PER_OBJECT
    // in folderScan.ts) via ScanResult.truncated and the wizard warns the user
    // before they commit. This loop used to destructure the walk result and
    // drop `truncated` on the floor, so an object over the cap imported its
    // first 50k files and reported plain success with no sign anything was
    // left behind.
    const truncatedFolders: string[] = [];
    for (const source of active) {
      const { files, skipped: walkSkips, truncated: sourceTruncated } = walkObjectFiles(source, settings);
      for (const [reason, v] of walkSkips) countSkip(importSkips, reason, v.count, v.bytes);
      if (sourceTruncated) truncatedFolders.push(source.folderName);
      walkedBySource.set(source, files);
      importStatus.filesTotal += files.length;
      for (const f of files) {
        plannedBytes += f.size;
        if (f.size > largestFileBytes) largestFileBytes = f.size;
      }
    }
    importStatus.bytesTotal = plannedBytes;
    if (truncatedFolders.length > 0) {
      const msg = `Hit the per-object file limit for ${truncatedFolders.join(', ')} — only the first files found were imported. Split large folders and import them separately to get the rest.`;
      importStatus.error = importStatus.error ? `${importStatus.error}; ${msg}` : msg;
    }

    // Free-space preflight. When the source is the upload staging area on the
    // same volume as the library, the copy loop below deletes each staged file
    // as soon as it lands, so net usage stays flat and only one file's worth of
    // headroom is actually needed. Every other case (staging on another volume,
    // or an in-place import from the user's own folder) genuinely adds the
    // whole import to the library's volume.
    const libraryVolumeDir = getLibraryDir();
    const requiredOnLibraryVolume = stagedSource && onSameVolume(IMPORT_TMP_BASE, libraryVolumeDir)
      ? largestFileBytes
      : plannedBytes;
    const space = checkFreeSpace(libraryVolumeDir, requiredOnLibraryVolume, 'to import these files');
    if (!space.ok) {
      log.warn(
        { required: space.requiredBytes, free: space.freeBytes, path: space.path, plannedBytes },
        '[folder-import] refused: not enough free space',
      );
      // The staged upload is discarded by the cleanup below, as it is on any
      // other failure, so the user isn't left with a full disk on top of a
      // failed import. Say so rather than letting them find out by re-opening
      // the wizard.
      throw new Error(
        (space.message ?? 'Not enough free space to import these files.') +
        (stagedSource ? ' The uploaded copy has been discarded, so nothing is left taking up room.' : ''),
      );
    }

    for (const source of active) {
      if (importCancelRequested) {
        importStatus.error = 'Import cancelled. Files already copied were kept; the rest will be picked up on the next run.';
        importStatus.cancelled = true;
        break;
      }
      const objPlan = planByFolder.get(source.folderName)!;
      importStatus.currentObject = source.folderName;

      const rawTargetInput = (objPlan.targetObjectId || source.folderName).trim();
      const normalizedTarget = normalizeObjectId(rawTargetInput);
      let targetObjectId = resolveCanonicalId(normalizedTarget);
      // When the ID didn't resolve via alias, also try a catalog name lookup so
      // free-text like "California Nebula" or "CALIFORNIA NEBULA" → "NGC1499".
      if (targetObjectId === normalizedTarget) {
        const byName = getCatalogEntryByName(rawTargetInput);
        if (byName) targetObjectId = resolveCanonicalId(byName.id);
      }
      if (!targetObjectId) {
        console.warn(`[folder-import] Skipping "${source.folderName}": empty target id`);
        importStatus.objectsDone++;
        continue;
      }

      // Resolve (and remember) the destination folder for this object id.
      let objLocalDir = dirByObjectId.get(targetObjectId) ?? null;
      if (!objLocalDir) {
        // If the object already exists in the library, reuse its stored folder
        // name so previously imported files aren't orphaned by a rename (e.g.
        // importing a folder called "Andromeda" into an object already stored as
        // "M 31" would move the library pointer to "Andromeda" and leave every
        // prior session's files invisible on the old path).
        const existingFolderName = index.objects[targetObjectId]?.folderName;
        const requestedFolder = existingFolderName
          ? existingFolderName
          : (objPlan.targetFolderName || source.folderName).trim();
        objLocalDir = safeObjectDir(requestedFolder);
        if (!objLocalDir) {
          console.warn(`[folder-import] Skipping "${source.folderName}": unsafe folder name`);
          importStatus.objectsDone++;
          continue;
        }
        if (!fs.existsSync(objLocalDir)) fs.mkdirSync(objLocalDir, { recursive: true });
        dirByObjectId.set(targetObjectId, objLocalDir);
        folderNameByObjectId.set(targetObjectId, path.basename(objLocalDir));
      }

      log.info(
        { source: source.folderName, targetObjectId, dest: path.basename(objLocalDir) },
        '[folder-import] object',
      );

      // Walked once up front (see the pre-pass above), not here: the
      // free-space preflight needs the whole import's byte total before the
      // first file is copied.
      const files = walkedBySource.get(source)!;

      // Existing objects keep their shape; brand-new ones are created nested.
      const objectLayout = layoutByObjectId.get(targetObjectId)
        ?? layoutForImport(targetObjectId, !!index.objects[targetObjectId]);
      layoutByObjectId.set(targetObjectId, objectLayout);

      // Taken names, per destination directory. Flat objects have one bucket
      // (keyed ''), nested objects one per session folder — which is the whole
      // point: `stacked.jpg` in two different session directories is not a
      // collision and must not trigger a rename.
      const usedByDir = new Map<string, Set<string>>();
      const usedIn = (dir: string): Set<string> => {
        let set = usedByDir.get(dir);
        if (!set) {
          set = new Set<string>();
          try { for (const f of fs.readdirSync(path.join(objLocalDir!, dir))) set.add(f); }
          catch { /* directory does not exist yet */ }
          usedByDir.set(dir, set);
        }
        return set;
      };

      /** Session directory this file belongs in, '' for a flat object.
       *
       *  A folder mirroring a Dwarf (the NAS-copy case this wizard exists for)
       *  has the device's own session directory in each file's relPath, so it
       *  is reused verbatim — same result as importing from the device itself.
       *  Anything else groups by the resolved night, matching what the
       *  re-nesting migration does for legacy objects. */
      const sessionDirFor = (file: WalkedFile, night: string): string => {
        if (objectLayout !== 'nested') return '';
        const srcDir = path.dirname(file.relPath);
        const base = srcDir === '.' ? null : path.basename(srcDir);
        const source = base && isDwarfSessionFolder(base) ? base : null;
        return sessionFolderFor(source, night, null) ?? night;
      };

      let cancelledMidObject = false;
      for (const file of files) {
        if (importCancelRequested) { cancelledMidObject = true; break; }
        const target = resolveTargetDate(objPlan.sessionMap, file.derived.date, file.derived.time);
        if (!target || !ISO_DATE.test(target)) {
          log.info({ file: file.name, derivedDate: file.derived.date ?? null, reason: 'date-dropped' }, '[folder-import] skip');
          // Not counted in skippedFiles: that number is rendered as "already
          // synced", which these files are not. They were dropped.
          countSkip(importSkips, 'date-dropped');
          importStatus.filesDone++;
          continue;
        }

        // Never re-import tombstoned sessions (strict policy) — matches
        // runImport's deletedSessions check (import.ts:1078). Without this, a
        // user who deletes a session and re-runs the wizard against a source
        // folder that still has those files silently resurrects it.
        if (index.objects[targetObjectId]?.deletedSessions?.includes(target)) {
          log.info({ file: file.name, objectId: targetObjectId, date: target, reason: 'deleted-session' }, '[folder-import] skip');
          countSkip(importSkips, 'deleted-session');
          importStatus.filesDone++;
          continue;
        }

        const sessionDir = sessionDirFor(file, target);
        const used = usedIn(sessionDir);

        // Idempotency: the deterministic "natural" name (no dedup) tells us
        // whether this file was already imported on a previous run. Nested
        // objects keep the source name, so that name IS the natural one.
        const naturalName = objectLayout === 'nested'
          ? file.name
          : canonicalImportName(file.name, target, file.derived.date, file.derived.time, EMPTY_NAMES);
        if (fs.existsSync(path.join(objLocalDir, sessionDir, naturalName))) {
          log.info({ file: naturalName, objectId: targetObjectId }, '[folder-import] exists');
          importStatus.skippedFiles++;
          importStatus.filesDone++;
          used.add(naturalName);
          continue;
        }

        // Nested: keep the source name. It only falls back to the canonical
        // rewrite if that exact name is somehow already taken *within this
        // session directory* — two source folders with no session dir of their
        // own merging into one night. Rare, but silently overwriting a file
        // would be much worse than an ugly name.
        const destName = objectLayout === 'nested' && !used.has(file.name)
          ? file.name
          : canonicalImportName(file.name, target, file.derived.date, file.derived.time, used);
        used.add(destName);
        const destRel = sessionDir ? `${sessionDir}/${destName}` : destName;
        const destPath = path.join(objLocalDir, destRel);
        try {
          if (sessionDir) await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          // Async copy so a large file doesn't block the event loop mid-import.
          await fs.promises.copyFile(file.absPath, destPath);
          const size = fs.statSync(destPath).size;
          // Release the staged copy now that the library has the file. Done
          // per file rather than by deleting the whole temp dir at the end,
          // which is what made an upload need double its own size in free
          // space for the entire run. Only ever applied to our own staging
          // area, and only after the copy has succeeded and been stat'd.
          if (stagedSource) {
            try { await fs.promises.unlink(file.absPath); } catch { /* swept later */ }
          }
          importNewFiles.push({ name: `${path.basename(objLocalDir)}/${destRel}`, size });
          importBytesNew += size;
          importStatus.filesDone++;
          insertImportLogSafe(rootPath, file.relPath, targetObjectId, target, 'imported', null);
          log.info({ file: destName, objectId: targetObjectId, date: target, bytes: size }, '[folder-import] imported');
          const importedDates = importedDatesByObjectId.get(targetObjectId) ?? new Set<string>();
          importedDates.add(target);
          importedDatesByObjectId.set(targetObjectId, importedDates);
          // `target` is the resolved session night, which for the unsorted
          // bucket is a date the user assigned by hand. Pin it as an override
          // whenever it doesn't match what the file's own date would derive to,
          // so the row keeps the user's decision instead of relying on the
          // timestamp canonicalImportName clamped into the name to reproduce it.
          const derivedNight = file.derived.date
            ? observingNightDate(file.derived.date, file.derived.time)
            : null;
          recordLibraryFile({
            objectId: targetObjectId,
            folderName: path.basename(objLocalDir),
            sessionFolder: sessionDir || null,
            fileName: destName,
            originalName: file.name,
            role: roleForFile(destName, { fromSubFolder: file.fromSubFolder }),
            captureDate: file.derived.date ?? null,
            captureTime: file.derived.time ?? null,
            sessionDateOverride: derivedNight === target ? null : target,
            telescopeId: plan.telescopeId ?? null,
            bytes: size,
            sourcePath: file.relPath,
          });
          if (isCaptureInfoSidecar(destName)) {
            ingestCaptureInfoFile(
              targetObjectId,
              `${path.basename(objLocalDir)}/${destRel}`,
              sessionDir,
              target,
            );
          }
        } catch (err) {
          importStatus.filesDone++;
          const message = err instanceof Error ? err.message : 'copy failed';
          insertImportLogSafe(rootPath, file.relPath, targetObjectId, target, 'error', message);
          log.warn({ file: file.name, objectId: targetObjectId, err: message }, '[folder-import] copy-error');
        }
      }

      if (cancelledMidObject) {
        importStatus.error = 'Import cancelled. Files already copied were kept; the rest will be picked up on the next run.';
        importStatus.cancelled = true;
      }

      // Refreshed once per object, same cadence as the telescope path, so the
      // polling UI can show the running total without re-sorting per file.
      importStatus.skipped = summarizeSkips(importSkips);

      // Reconcile sessions + file count from disk so merges and the read-path
      // grouping (parseFilename + sessionNightFor per file) are reflected exactly.
      const sessionSet = new Set<string>();
      let fileCount = 0;
      try {
        // Layout-aware, and dot-prefixed bookkeeping (.thumbs, the manifest) is
        // excluded by listObjectFiles so it never counts as an imported file.
        const existing = listObjectFiles(objLocalDir, objectLayout);
        const identity = resolverFor(targetObjectId);
        for (const entry of existing) {
          const night = identity.session(entry.relPath);
          if (night) sessionSet.add(night);
        }
        fileCount = existing.length;
      } catch { /* ignore */ }

      log.info(
        { objectId: targetObjectId, sessions: Array.from(sessionSet), fileCount },
        '[folder-import] reconciled',
      );

      // If every session was dropped (or skipped) and the object didn't exist
      // before, don't leave an empty object behind — remove the dir we made.
      if (fileCount === 0 && !index.objects[targetObjectId]) {
        try { fs.rmdirSync(objLocalDir); } catch { /* not empty / in use — leave it */ }
        dirByObjectId.delete(targetObjectId);
        importStatus.objectsDone++;
        continue;
      }

      index.objects[targetObjectId] = {
        folderName: folderNameByObjectId.get(targetObjectId) ?? path.basename(objLocalDir),
        sessions: Array.from(sessionSet).sort(),
        fileCount,
        lastImport: new Date().toISOString(),
      };

      writeObjectManifest(targetObjectId, path.basename(objLocalDir));

      importStatus.objectsDone++;
    }

    // Only persist the objects this run actually processed. The full index was
    // loaded at import start and its snapshot of untouched objects may be stale:
    // resaving them could resurrect sessions the user deleted while the import
    // was running, or overwrite folderNames changed by concurrent moves.
    const touchedIds = new Set(dirByObjectId.keys());
    for (const id of Object.keys(index.objects)) {
      if (!touchedIds.has(id)) delete index.objects[id];
    }
    index.lastImport = new Date().toISOString();
    // Per-object writes, not saveIndex(index, ...): the session set reconciled
    // from disk above includes every date already on disk for the object, not
    // just what this run copied. Only stamp dates in importedDatesByObjectId
    // (files this run actually copied) with the selected telescope; every
    // other date — including pre-existing untagged sessions from earlier
    // imports — gets a plain, unattributed addSession so users can still tag
    // observations under an object independently of import.
    for (const [objectId, meta] of Object.entries(index.objects)) {
      const stampedDates = importedDatesByObjectId.get(objectId) ?? null;
      try {
        db.transaction(() => {
          const cat = resolveCatalogMeta(objectId);
          stmts.upsertObject.run(
            objectId, meta.folderName, meta.fileCount, meta.lastImport,
            meta.deleted ? 1 : 0, meta.deletedAt || null,
            cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
            cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy
          );
          if (commitProfile) stmts.setObjectPrimaryTelescopeIfNull.run(commitProfile.id, objectId);
          const chosenLayout = layoutByObjectId.get(objectId);
          if (chosenLayout) setObjectLayout(objectId, chosenLayout);
          for (const date of meta.sessions) {
            if (commitProfile && stampedDates?.has(date)) {
              // Force, not addSessionStamped: this date is confirmed to have
              // received new files from commitProfile in this run, so it must
              // win attribution even if an earlier import from a different
              // telescope already claimed this (objectId, date) session.
              stmts.addSessionStampedForce.run(objectId, date, commitProfile.id);
            } else {
              stmts.addSession.run(objectId, date);
            }
          }
          if (meta.deletedSessions) {
            for (const date of meta.deletedSessions) {
              stmts.addSessionTombstone.run(objectId, date);
            }
          }
        })();
      } catch (saveErr) {
        console.error(`[folder-import] Failed to save index for ${objectId}:`, saveErr instanceof Error ? saveErr.message : saveErr);
      }
    }
    stmts.updateMetaLastImport.run(index.lastImport);
    importStatus.lastRun = index.lastImport;

    // Best-effort enrichment + weather for everything we touched. Done after
    // saveIndex so the rows exist for enrichObjectData to update.
    for (const objectId of dirByObjectId.keys()) {
      try { await enrichObjectData(objectId); } catch { /* best-effort */ }
      try { await backfillSessionWeather(objectId); } catch (err) {
        console.warn(`[import] Weather backfill failed for "${objectId}":`, err instanceof Error ? err.message : err);
      }
    }

    // Pre-warm gallery thumbnails for newly-imported objects.
    if (importNewFiles.length > 0) {
      const newObjectIds = new Set(importNewFiles.map(f => normalizeObjectId(f.name.split('/')[0])));
      await pregenerateObjectThumbnails(newObjectIds);
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Folder import failed.';
    const lower = raw.toLowerCase();
    if (lower.includes('enospc') || lower.includes('no space left')) {
      // The preflight above catches this before any copying starts, so
      // reaching here means the disk filled from something else while the
      // import ran. Say so plainly instead of surfacing a raw errno.
      importStatus.error = stagedSource
        ? `The disk ran out of space during the import, so it stopped partway. Files ` +
          `that had already been imported are kept, but the rest of the upload could ` +
          `not be saved. Free up space, then upload the remaining folders again.`
        : `The disk ran out of space during the import, so it stopped partway. Free up ` +
          `space and run the import again: already-imported files are kept, so it will ` +
          `pick up where it left off.`;
    } else if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) {
      importStatus.error = `The server cannot read "${rootPath}". Check the folder's permissions.`;
    } else if (lower.includes('enoent') || lower.includes('no such file')) {
      importStatus.error = `The folder "${rootPath}" disappeared during the import. Reconnect the drive and try again.`;
    } else {
      importStatus.error = raw;
    }
  } finally {
    importStatus.skipped = summarizeSkips(importSkips);
    try {
      stmts.insertHistory.run(
        importStatus.startedAt,
        new Date().toISOString(),
        importStatus.objectsTotal,
        importStatus.filesTotal,
        importNewFiles.length,
        importStatus.bytesTotal,
        importBytesNew,
        importStatus.error || null,
        importNewFiles.length > 0 ? JSON.stringify(importNewFiles.map(f => f.name)) : null,
        importStatus.telescopeId,
        importStatus.telescopeName,
        importStatus.transportKind,
        importStatus.skipped.length > 0 ? JSON.stringify(importStatus.skipped) : null,
        importStatus.manual ? 1 : 0,
        importStatus.cancelled ? 1 : 0,
      );
    } catch { /* best-effort */ }
    log.info(
      {
        objects: importStatus.objectsDone,
        newFiles: importNewFiles.length,
        alreadyPresent: importStatus.skippedFiles,
        skipped: importStatus.skipped,
        error: importStatus.error ?? null,
      },
      '[folder-import] done',
    );
    if (importNewFiles.length > 0) invalidateAllImagesCache();
    importStatus.running = false;
    importStatus.currentObject = null;

    // Auto-cleanup the temp dir created by /import/upload-temp once the commit
    // completes (success or error). The copy loop already unlinked each staged
    // file as it landed, so by now this is mostly empty directories plus
    // anything that was skipped or failed. isStagedPath resolves before
    // comparing, so a client-supplied rootPath can never point this at an
    // arbitrary directory.
    if (stagedSource) {
      try { fs.rmSync(path.resolve(rootPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  } finally {
    releaseImportLock();
  }
}

/** Shared empty set for canonicalImportName's no-dedup "natural name" lookup.
 *  canonicalImportName never mutates `used`, so a single instance is safe. */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

/** Folder imports have no telescope, so sessionImportLog's NOT NULL telescopeId
 *  gets a sentinel. Best-effort: a logging failure must not abort the import. */
function insertImportLogSafe(
  rootPath: string,
  relPath: string,
  objectId: string,
  sessionDate: string,
  outcome: string,
  message: string | null,
): void {
  try {
    stmts.insertSessionImportLog.run(
      'folder-import',
      `${rootPath}/${relPath}`,
      new Date().toISOString(),
      objectId,
      sessionDate,
      outcome,
      message,
      null, // deviceId — folder imports have no paired device
    );
  } catch { /* best-effort */ }
}

// ─── Manual observation creation ─────────────────────────────────────────────

/** Extensions createManualObservation will write to disk. Mirrors the
 *  fileFilter on the /manual-observations multer route, but enforced again
 *  here since this function is the actual write boundary and must not trust
 *  a route-level check to always stay in sync. */
const MANUAL_OBSERVATION_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);

export function createManualObservation(
  objectName: string,
  date: string,        // YYYY-MM-DD
  imageBuffer: Buffer | null,
  imageExt: string | null,  // 'jpg', 'png', etc. (without dot)
  telescopeId: string | null = null,
): { objectId: string; date: string } {
  const trimmedName = objectName.trim();
  const safeName = normalizeObjectId(trimmedName.replace(/[/\\<>:"|?*]/g, ''));
  if (!safeName) throw new Error('The object name is empty or contains only characters that cannot be used in a folder. Use letters, digits, spaces, or dashes.');

  // Resolve to canonical catalog ID when the user typed a common name instead
  // of selecting from the dropdown (e.g. "CALIFORNIA NEBULA" → "NGC1499").
  const byName = getCatalogEntryByName(trimmedName);
  const objectId = byName
    ? resolveCanonicalId(byName.id)
    : resolveCanonicalId(safeName);
  // Use the resolved ID as the on-disk folder name so the observation lands in
  // the right place when a catalog match was found. Reuse an already-existing
  // object's stored folder name (don't rename it out from under it); only a
  // brand-new object gets the catalog-preference treatment.
  const existingRow = stmts.getObject.get(objectId);
  const preferCaldwell = loadSettings().preferredCatalog === 'caldwell';
  const folderName = existingRow?.folderName || applyCatalogPreference(objectId, preferCaldwell);

  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) throw new Error('The date is not in the expected YYYY-MM-DD format. Pick a date from the date picker and try again.');

  // Every other import path resolves its destination through safeObjectDir,
  // which rejects a folder name that escapes LIBRARY_DIR (e.g. "..", or a
  // catalog alias that somehow round-tripped to one). This function used to
  // path.join the raw folderName directly, so objectName: ".." wrote the
  // uploaded image straight into DATA_DIR next to the database and secrets.
  const objDir = safeObjectDir(folderName);
  if (!objDir) throw new Error(`Cannot create an observation for "${objectName}": the resolved folder name is unsafe.`);

  ensureLibraryDir();
  if (!fs.existsSync(objDir)) {
    fs.mkdirSync(objDir, { recursive: true });
  }

  // Save image with timestamp-based filename so parseFilename detects the date.
  // The user picked `date` explicitly (it's not derived from a real capture
  // time), so the embedded time-of-day must be clamped into the rollover-safe
  // zone — otherwise entering this at, say, 2am would embed an early hour next
  // to the chosen date and sessionNightFor would roll it back a day on read.
  if (imageBuffer && imageExt) {
    const ext = imageExt.replace(/^\./, '').toLowerCase();
    if (!MANUAL_OBSERVATION_IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image type "${imageExt}". Use JPG or PNG.`);
    }
    const now = new Date();
    const rawHms = `${String(now.getHours()).padStart(2, '0')}${
      String(now.getMinutes()).padStart(2, '0')}${
      String(now.getSeconds()).padStart(2, '0')}`;
    const ts = `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}-${clampToNightSafeTime(rawHms)}`;
    const filename = `${objectId}_${ts}.${ext}`;
    fs.writeFileSync(path.join(objDir, filename), imageBuffer);
  }

  // Update library DB: ensure object + date are tracked. Capture each
  // existing session's telescopeId first: clearSessions below wipes every
  // row for this object, so re-adding without restoring these would silently
  // un-tag every prior session, not just the new one.
  const existingSessions = stmts.getSessions.all(objectId).filter(r => r.date !== 'unknown');
  const telescopeIdByDate = new Map(existingSessions.map(r => [r.date, r.telescopeId]));
  const sessionSet = new Set<string>();
  for (const r of existingSessions) sessionSet.add(r.date);
  sessionSet.add(date);

  let fileCount = 0;
  try {
    const allLocal = fs.readdirSync(objDir).filter(f => {
      const night = sessionNightFor(parseFilename(f));
      if (night) sessionSet.add(night);
      return isRealFile(f);
    });
    fileCount = allLocal.length;
  } catch {
    fileCount = imageBuffer ? 1 : 0;
  }

  const now = new Date().toISOString();
  const cat = resolveCatalogMeta(objectId);
  stmts.upsertObject.run(objectId, folderName, fileCount, now, 0, null,
    cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
    cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
  stmts.clearSessions.run(objectId);
  for (const d of sessionSet) {
    const stampId = (d === date ? telescopeId : null) ?? telescopeIdByDate.get(d) ?? null;
    if (stampId) stmts.addSessionStamped.run(objectId, d, stampId);
    else stmts.addSession.run(objectId, d);
  }

  return { objectId, date };
}
