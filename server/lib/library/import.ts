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
import { writeImportHistory } from './importHistory.js';
import {
  getProfileById,
  getManualImportProfiles,
  setProfileDeviceId,
  type TelescopeProfile,
} from '../telescopes.js';
import { smbListDir, smbGetFile, type SmbEntry } from '../smb.js';
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
  discoverGenericObjects,
  listGenericObjectFiles,
  buildGenericFilePath,
  discoverAsiairObjects,
  listAsiairObjectFiles,
  buildAsiairFilePath,
  asiairLocalName,
  resolveAsiairRoot,
  ASIAIR_CALIBRATION_PATHS,
  type WalkerConfig,
  type GenericDiscoveredObject,
  type AsiairDiscoveredObject,
} from '../walkers/index.js';
import { isAsiairKind } from '../types/telescopeKind.js';
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
  type LibraryIndex,
} from './objects.js';
import { resolveObjectImagePath, invalidateAllImagesCache, objectThumbnailDiskCacheKey } from './gallery.js';
import { writeFileIntoLibrary, copyTransportFile } from './importWrite.js';
import { recordLibraryFiles, roleForFile, resolverFor, writeObjectManifest, type RecordFileInput } from './libraryFiles.js';
import { isCaptureInfoSidecar, ingestCaptureInfoFile } from './captureInfo.js';
import { getStartrailsObjectId, patchStartrailsObjectMeta } from './dwarfStartrails.js';
import { collectRemoteArchiveCandidates, downloadToArchive } from './remoteArchive.js';
import { RESTACKED_FOLDER, isRestackedFolder, resolveRestackTargetId, mimeTypeForExtension, SHOTS_INFO_FILENAME, targetFromShotsInfo, isDwarfThumbnailPreviewName } from './dwarfRestack.js';
import { addProcessedImage, hasRestackedImage, isRenderableProcessedName, isStoredOnlyProcessedName } from './processed.js';
import {
  sessionFolderFor,
  layoutForImport,
  getObjectLayout,
  setObjectLayout,
  listObjectFiles,
  sanitizeSessionFolder,
  type LibraryLayout,
} from './libraryLayout.js';
import { enqueueSessionWeatherBackfill, getSessionTelescopeId } from './observations.js';
import {
  classifyImportFile,
  isDwarfMasterStack,
  countSkip,
  summarizeSkips,
  isImportSkipReason,
  type ImportSkipReason,
  type ImportSkipSummary,
  type SkipTally,
} from './importFilter.js';
import { isRecord } from '../typeGuards.js';
import { isContainerFolder, groupByTarget, stripCaptureModeSuffix } from './objectDiscovery.js';
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
import {
  getArchiveDir,
  getRestackArchiveDir,
  migrateRestackedToSharedRootOnce,
  RESTACKED_ROOT_DIR_NAME,
  collectArchiveCandidates,
  copyToArchive,
  type ArchiveCandidate,
} from './archiveFolders.js';
import { deviceNoun, isGenericShare, offlineAdvice } from '../deviceWording.js';
import { canonicalImportName } from './importNaming.js';
import { debugLog } from '../debugLogger.js';
import { log } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

// ImportStatus/TouchedObject/TouchedSession live in importTypes.ts (see that
// file's header for why) and are re-exported here so every existing importer
// of them from './import.js' (including the library/index.ts barrel) keeps
// working unchanged.
export type { ImportStatus, TouchedObject, TouchedSession } from './importTypes.js';
import type { ImportStatus, TouchedObject, TouchedSession } from './importTypes.js';

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
  /** Sub-frame sync only: when `syncObjectSubFrames` drives one night at a
   *  time, each `syncSessionSubFrames` call runs with `rollup: true` so it
   *  neither resets the shared run accumulators nor writes its own Sync
   *  History row — the whole-object caller owns both, and "sync all
   *  sub-frames" lands as a single history entry. */
  rollup?: boolean;
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
  /** Catalog objects that received at least one new file this run, deduped,
   *  each flagged for whether the object itself was brand-new. Null for rows
   *  written before this was tracked, and for runs that added no files. */
  objectsTouched: TouchedObject[] | null;
  /** Observation nights (object + date) that received at least one new file
   *  this run, deduped, each flagged for whether the night itself was new.
   *  Null under the same conditions as `objectsTouched`. */
  sessionsTouched: TouchedSession[] | null;
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

let currentImportWalker: WalkerConfig = { basePath: 'MyWorks' };

// Transient tracking of new files downloaded in the current import run
let importNewFiles: Array<{ name: string; size: number }> = [];
let importBytesNew = 0;
// Deduped per-run summaries, keyed by objectId / `${objectId}|${date}`. Built
// alongside importNewFiles so the Sync History detail view can show "what
// changed" (objects created vs. added to, observations created vs. added to)
// without re-deriving it from the flat file list.
let importObjectsTouched: Map<string, TouchedObject> = new Map();
let importSessionsTouched: Map<string, TouchedSession> = new Map();

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
          const cacheKey = objectThumbnailDiskCacheKey(srcPath, THUMB_W, THUMB_H, mtimeMs);
          const cachePath = path.join(THUMBNAILS_DIR, `${cacheKey}.jpg`);
          if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
            await sharp(srcPath)
              .resize(THUMB_W, THUMB_H, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80, progressive: true })
              .toFile(cachePath);
          }
        }
      } catch (err) {
        // Never block import completion — the thumbnail regenerates on
        // demand elsewhere — but a repeated failure here is worth seeing.
        log.warn({ err: err instanceof Error ? err.message : String(err), objectId }, '[import] thumbnail pre-warm failed');
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
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo') || lower.includes('host not found')) {
    return `Could not find ${name}${host ? ` at ${host}` : ''}. Check the hostname or IP address in Settings, Hardware.`;
  }
  if (lower.includes('smbclient is not installed')) {
    return 'The server is missing the smbclient program it needs to read SMB shares. '
      + 'Install the samba client package on the host (the official Docker image already includes it).';
  }
  if (lower.includes('ehostunreach') || lower.includes('enetunreach') || lower.includes('host is down')) {
    return `${name} is not reachable on the network. ${offlineAdvice(profile?.kind)}`;
  }
  if (
    lower.includes('nt_status_logon_failure') || lower.includes('logon_failure')
    || lower.includes('access denied') || lower.includes('nt_status_access_denied')
    || lower.includes('authentication failed') || lower.includes('session setup failed')
    || lower.includes('bad password') || lower.includes('wrong password')
  ) {
    return `${name} refused the login. Open Settings, Hardware, ${name}, and check the SMB username and password. `
      + 'A share that only allows guests needs the username and password fields left blank.';
  }
  if (lower.includes('smb protocol negotiation failed') || lower.includes('nt_status_connection_reset')) {
    return `${name} answered but would not agree on an SMB protocol version. `
      + 'The share may require SMB1, or a minimum of SMB2/SMB3 that the other end does not offer. Check its SMB settings.';
  }
  if (lower.includes('nt_status_bad_network_name') || lower.includes('bad_network_name')) {
    return generic
      ? `${name} has no share by that name. Open Settings, Hardware, ${name}, and check the SMB share name.`
      : `${name} does not expose the expected file share. Make sure the telescope is fully booted and SMB sharing is on.`;
  }
  if (lower.includes('failed to connect to smb') || lower.includes('smb connection')) {
    // The raw reason was too generic for smbclient to classify (it lands here
    // as "SMB connection failed: Connection failed"). The host answered enough
    // for smbclient to run, so this is a share/credential/protocol problem, not
    // a power or network one. Keep the raw tail so support can still see it.
    return `${name}${host ? ` at ${host}` : ''} answered but the SMB share could not be opened. `
      + `Check the SMB share name, username, and password in Settings, Hardware. (${raw})`;
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

/**
 * Registers a bare library object for a RESTACKED target that doesn't exist
 * yet, so a Dwarf MegaStack of a target the user has never separately
 * imported a session for lands as a real object instead of archived bytes.
 *
 * Ordinary session folders already get this trust level with no gate at all
 * — the walker creates an object from whatever the device calls the target
 * folder, however implausible (this library has a real object literally
 * named "Unknown", because that's what the device wrote). Requiring RESTACKED
 * targets to already exist was a stricter bar than that, and the practical
 * effect was that a Dwarf resync of a target you hadn't yet imported an
 * ordinary session for silently dumped its MegaStack into `_archive/`
 * instead of the object it plainly named — see resolveRestackTargetId's own
 * doc for the two ways a target gets resolved.
 *
 * A no-op when the object already exists (and isn't soft-deleted) — the
 * RESTACKED loop then just attaches the processed image to it, which is the
 * "combine" side of create-or-combine. Mirrors the enrichment shape the main
 * per-target import loop and createManualObservation both use: a fresh
 * `index.objects` entry with no sessions (RESTACKED files aren't tied to a
 * single observing night — see addProcessedImage's 'dwarf-restack' source),
 * plus a `libraryObjects` row via resolveCatalogMeta so it shows up in the
 * UI immediately rather than waiting for this run's end-of-loop save.
 */
function ensureRestackObject(targetId: string, index: LibraryIndex, telescopeId: string | null): void {
  if (index.objects[targetId] && !index.objects[targetId].deleted) return;
  const preferCaldwell = loadSettings().preferredCatalog === 'caldwell';
  const folderName = applyCatalogPreference(targetId, preferCaldwell);
  const lastImport = new Date().toISOString();
  index.objects[targetId] = { folderName, sessions: [], fileCount: 0, lastImport };
  try {
    db.transaction(() => {
      const cat = resolveCatalogMeta(targetId);
      stmts.upsertObject.run(
        targetId, folderName, 0, lastImport, 0, null,
        cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
        cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy,
      );
      if (telescopeId) stmts.setObjectPrimaryTelescopeIfNull.run(telescopeId, targetId);
    })();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), targetId }, '[import] failed to create object for RESTACKED target');
  }
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
  // Set once this run mints its own importStatus below (with a fresh runId).
  // Passed to releaseImportLock() so a watchdog-force-released run that later
  // wakes up from a hung await can't clobber a newer run that has since
  // claimed the lock and replaced `importStatus` with its own object.
  let myRunId: string | null = null;
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
  myRunId = importStatus.runId;
  importNewFiles = [];
  importBytesNew = 0;
  importObjectsTouched = new Map();
  importSessionsTouched = new Map();
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
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), telescopeId: profile.id, transportId: activeTransport.id },
        '[import] device identity probe failed; carrying on with whatever runDeviceId we have',
      );
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
  // 'other' also supports the documented "Generic SMB Layout" (nested
  // <object>/<YYYY-MM-DD>_<HHMM>/lights|subframes session folders), tried
  // first per object; any object with no such session folders falls back to
  // the flat SeeStar-style layout below, so an existing flat custom-SMB
  // setup keeps working unchanged.
  const isGeneric = profile.kind === 'other';
  // ASIAIR nests target folders under a capture-mode and frame-type pair
  // (Autorun|Plan/Light/<Target>, plus Live/<Target>), which no basePath can
  // express, so it gets its own discovery branch like Dwarf and generic do.
  const isAsiair = isAsiairKind(profile.kind);

  // Vendor-specific object discovery.
    interface ObjectToImport {
      objectName: string;
      subFolderName: string | null;
      // Only set for Dwarf: the real session folders under Astronomy/.
      dwarfSessionFolders: string[];
      // Only set for the synthetic Star Trails object: base path
      // dwarfSessionFolders are joined against (Astronomy/STARTRAILS rather
      // than Astronomy/ directly).
      dwarfSessionBase?: string;
      // Only set for a generic ('other') object using the documented
      // Generic SMB Layout: the <YYYY-MM-DD>_<HHMM> session folders found
      // under it, each already verified to hold a non-empty lights/.
      genericSessionFolders: string[];
      // Only set for ASIAIR: where this target's files were found, since one
      // target can appear under Autorun, Plan and Live at once.
      asiairObject?: AsiairDiscoveredObject;
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
          dwarfSessionBase: o._dwarfSessionBase,
          genericSessionFolders: [],
        }));
    } else if (isAsiair) {
      debugLog('import:discover', `ASIAIR: scanning ${transportAddress} for objects`);
      const discovered = await discoverAsiairObjects(profile);
      debugLog('import:discover', `ASIAIR: found ${discovered.length} object(s) total`);
      if (discovered.length > 0) debugLog('import:discover', `Objects: ${discovered.map(o => o.folderName).join(', ')}`);
      toImport = discovered
        .filter(o => !targetObjectId || resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId)
        .filter(o => !index.objects[resolveCanonicalId(normalizeObjectId(o.folderName))]?.deleted)
        .map(o => ({
          objectName: o.folderName,
          subFolderName: null,
          dwarfSessionFolders: [],
          genericSessionFolders: [],
          asiairObject: o,
        }));
    } else {
      // Generic ('other') sources may follow the documented Generic SMB
      // Layout (nested session folders). Try that first — anything it finds
      // is excluded from the flat listing below so it isn't processed twice.
      let genericObjects: GenericDiscoveredObject[] = [];
      if (isGeneric) {
        debugLog('import:discover', `Generic: scanning ${transportAddress} for the documented session-folder layout`);
        try {
          genericObjects = await discoverGenericObjects(profile);
          if (genericObjects.length > 0) debugLog('import:discover', `Generic: ${genericObjects.length} object(s) with session folders: ${genericObjects.map(o => o.folderName).join(', ')}`);
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, '[import] generic-layout discovery failed; falling back to flat layout only');
        }
      }
      const genericObjectNames = new Set(genericObjects.map(o => o.folderName));

      debugLog('import:discover', `SeeStar: connecting to ${transportAddress}, listing ${walkerBase || '/'}`);
      // Per-object listings later in this run are already isolated (each is
      // its own try/catch that skips just that object on failure). This root
      // listing has no such fallback — a failure here aborts the entire run
      // — so it gets one retry for a transient SMB blip before propagating.
      let entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }>;
      try {
        entries = await smbListDir(walkerBase, profile);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), walkerBase }, '[import] root listing failed, retrying once');
        entries = await smbListDir(walkerBase, profile);
      }
      const objectFolders = entries.filter(e => e.type === 'dir' && isObjectFolder(e.name) && !genericObjectNames.has(e.name));
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
              genericSessionFolders: [],
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
        ...genericObjects
          .filter(o => !targetObjectId || resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId)
          .filter(o => !index.objects[resolveCanonicalId(normalizeObjectId(o.folderName))]?.deleted)
          .map(o => ({
            objectName: o.folderName,
            subFolderName: null,
            dwarfSessionFolders: [],
            genericSessionFolders: o._genericSessionFolders ?? [],
          })),
        ...(targetObjectId
          ? normalFolders.filter(e => resolveCanonicalId(normalizeObjectId(stripCaptureModeSuffix(e.name))) === targetObjectId)
          : normalFolders
        )
          .filter(e => !index.objects[resolveCanonicalId(normalizeObjectId(stripCaptureModeSuffix(e.name)))]?.deleted)
          .map(objEntry => {
            // `Lunar_video` and `Lunar` are one object; the suffix is a SeeStar
            // capture mode, not part of the target name. The `_sub` lookup still
            // keys on the raw folder name: a `_video` folder never has a `_sub`
            // companion, and stripping first could wrongly attach the stills
            // folder's `_sub` to it.
            const objectName = stripCaptureModeSuffix(objEntry.name);
            return {
              objectName,
              // The stripped name is the library destination; the raw folder is
              // still where the files are read from on the share.
              remoteFolderName: objectName === objEntry.name ? undefined : objEntry.name,
              subFolderName: subFolders.find(s => getObjectFromSubFolder(s.name) === objEntry.name)?.name ?? null,
              dwarfSessionFolders: [],
              genericSessionFolders: [],
            };
          }),
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
        let files: Array<{ name: string; size?: number; mtime?: string }>;
        let subFiles: Array<{ name: string; size?: number; mtime?: string }>;
        try {
          ({ files, subFiles } = await listDwarfObjectFiles(
            profile,
            {
              folderName: objectName,
              subFolderName: null,
              _dwarfSessionFolders: obj.dwarfSessionFolders,
              _dwarfSessionBase: obj.dwarfSessionBase,
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
        const toImportFile = (e: { name: string; size?: number; mtime?: string }, fromSub: boolean): ImportFile | null => {
          // listDwarfObjectFiles tags entries as `<sessionFolder>/<basename>`, or
          // `<sessionFolder>/<subDir>/<basename>` for a file inside a session
          // sub-directory (archive mode only). The sub-directory is preserved on
          // disk so the copy mirrors the device instead of flattening it.
          const parts = e.name.split('/');
          const sessionFolder = parts.length > 1 ? parts[0] : '';
          const subPath = sanitizeDwarfSubPath(parts.slice(1, -1));
          const basename = parts[parts.length - 1];
          // The synthetic Star Trails object's capture folders carry no
          // target and may carry no parseable timestamp either (unverified
          // real layout) — fall back to the file's own mtime rather than
          // leaving the capture undated when a perfectly good date is
          // sitting right there. A *file's* mtime, not the folder's: local
          // directory listings never populate mtime for directory entries
          // (only files), so a folder-level fallback would silently never
          // fire on local/USB transports.
          const night = dwarfFolderNightDate(sessionFolder)
            ?? (e.mtime ? e.mtime.slice(0, 10) : null);

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
              countSkip(importSkips, 'unsupported-type', 1, 0, [basename]);
              return null;
            }
            const sessionDir = sessionFolderFor(sessionFolder || null, night, null);
            const dir = sessionDir && subPath ? `${sessionDir}/${subPath}` : sessionDir;
            if (!dir) {
              debugLog('import:dwarf', `Skipping Dwarf file (unusable session folder): ${e.name}`);
              countSkip(importSkips, 'undecodable-session-folder', 1, 0, [basename]);
              return null;
            }
            return {
              localName: basename,
              sessionFolder: dir,
              originalName: basename,
              remotePath: buildDwarfFilePath(e.name, obj.dwarfSessionBase),
              size: e.size,
              fromSub,
              date: night,
            };
          }

          const named = dwarfLocalName(basename, sessionFolder);
          if (named.name === null) {
            debugLog('import:dwarf', `Skipping Dwarf file (${named.reason}): ${e.name}`);
            countSkip(importSkips, named.reason, 1, 0, [basename]);
            return null;
          }
          return {
            localName: named.name,
            sessionFolder: null,
            originalName: basename,
            remotePath: buildDwarfFilePath(e.name, obj.dwarfSessionBase),
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
            subFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
            subFiles.map(f => f.name));
        }
        allFiles = [
          ...files.map(f => toImportFile(f, false)).filter(isImportFile),
          ...(wantSubFrames ? subFiles.map(f => toImportFile(f, true)).filter(isImportFile) : []),
        ];
      } else if (isGeneric && obj.genericSessionFolders.length > 0) {
        // The documented Generic SMB Layout: one unreadable session folder
        // must not abort every remaining object, matching the isolation the
        // Dwarf and SeeStar branches already give their own per-folder reads.
        let files: SmbEntry[];
        let subFiles: SmbEntry[];
        try {
          ({ files, subFiles } = await listGenericObjectFiles(profile, {
            folderName: objectName,
            subFolderName: null,
            _genericSessionFolders: obj.genericSessionFolders,
          }));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          debugLog('import:error', `Failed to list generic session files for "${objectName}" — ${reason}`);
          console.error(`[import] Failed to list generic session files for "${objectName}":`, reason);
          const msg = `Could not read session files for "${objectName}" (${reason}).`;
          importStatus.error = importStatus.error ? `${importStatus.error}; ${msg}` : msg;
          importStatus.objectsDone++;
          continue;
        }
        const toImportFile = (e: { name: string; size?: number }, fromSub: boolean): ImportFile | null => {
          // listGenericObjectFiles tags entries as `<session>/<basename>`
          // (meta.json and any other loose file in the session folder) or
          // `<session>/lights|subframes/<basename>`.
          const parts = e.name.split('/');
          const session = parts[0];
          const basename = parts[parts.length - 1];
          if (!isSafeRemoteFileName(basename)) {
            debugLog('import:generic', `Skipping generic file (unsafe name): ${e.name}`);
            countSkip(importSkips, 'unsupported-type', 1, 0, [basename]);
            return null;
          }
          // Session folder is <YYYY-MM-DD>_<HHMM> by construction (discoverGenericObjects
          // only keeps folders matching that pattern), so the date is always its first 10 chars.
          const date = session.slice(0, 10);

          if (objectLayout === 'nested') {
            return {
              localName: basename,
              sessionFolder: sessionFolderFor(session, date, null),
              originalName: basename,
              remotePath: buildGenericFilePath({ folderName: objectName }, e.name),
              size: e.size,
              fromSub,
              date,
            };
          }

          // Flat layout (an existing object created before this feature, or
          // before it had any nested session): prefix the session folder onto
          // the basename so files from different sessions never collide
          // inside the one flat directory a flat object stores everything in.
          return {
            localName: `${session}_${basename}`,
            sessionFolder: null,
            originalName: basename,
            remotePath: buildGenericFilePath({ folderName: objectName }, e.name),
            size: e.size,
            fromSub,
            date,
          };
        };
        const isImportFile = (f: ImportFile | null): f is ImportFile => f !== null;
        const wantSubFrames = settings.importSubFrames === true || settings.archiveAllFiles === true;
        if (!wantSubFrames) {
          countSkip(importSkips, 'sub-frames-disabled', subFiles.length,
            subFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
            subFiles.map(f => f.name));
        }
        allFiles = [
          ...files.map(f => toImportFile(f, false)).filter(isImportFile),
          ...(wantSubFrames ? subFiles.map(f => toImportFile(f, true)).filter(isImportFile) : []),
        ];
      } else if (isAsiair && obj.asiairObject) {
        // ASIAIR: Autorun/Plan light frames are sub-frames, Live/ output is the
        // finished image. One unreadable source directory must not abort the
        // remaining objects, matching the isolation the branches above give
        // their own per-folder reads.
        let files: SmbEntry[];
        let subFiles: SmbEntry[];
        try {
          ({ files, subFiles } = await listAsiairObjectFiles(profile, obj.asiairObject));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          debugLog('import:error', `Failed to list ASIAIR files for "${objectName}" — ${reason}`);
          console.error(`[import] Failed to list ASIAIR files for "${objectName}":`, reason);
          const msg = `Could not read files for "${objectName}" (${reason}).`;
          importStatus.error = importStatus.error ? `${importStatus.error}; ${msg}` : msg;
          importStatus.objectsDone++;
          continue;
        }
        const toImportFile = (e: { name: string; size?: number }, fromSub: boolean): ImportFile | null => {
          // listAsiairObjectFiles tags entries with the full source directory
          // (`Autorun/Light/M42/<basename>`), which is already the remote path.
          const basename = asiairLocalName(e.name);
          if (!isSafeRemoteFileName(basename)) {
            debugLog('import:asiair', `Skipping ASIAIR file (unsafe name): ${e.name}`);
            countSkip(importSkips, 'unsupported-type', 1, 0, [basename]);
            return null;
          }
          const night = sessionNightFor(parseFilename(basename));
          return {
            // ASIAIR names carry the target and a full timestamp, so they are
            // unique across capture modes and nights and need no rewriting.
            // The file keeps the name the device gave it (CLAUDE.md, "Imported
            // File Preservation").
            localName: basename,
            // Like SeeStar, ASIAIR has no session directory of its own: frames
            // from many nights sit flat in one target folder. A nested object
            // gets a canonical session folder built from the frame's own
            // observing night.
            sessionFolder: objectLayout === 'nested' ? sessionFolderFor(null, night, null) : null,
            originalName: basename,
            remotePath: buildAsiairFilePath(e.name),
            size: e.size,
            fromSub,
            date: night,
          };
        };
        const isImportFile = (f: ImportFile | null): f is ImportFile => f !== null;
        const wantSubFrames = settings.importSubFrames === true || settings.archiveAllFiles === true;
        if (!wantSubFrames) {
          // Worth counting loudly here: for ASIAIR this is not a slice of the
          // run, it is almost all of it. New ASIAIR profiles are created with
          // importSubFrames on for exactly this reason (telescopes.ts), so a
          // user seeing this number has turned it off deliberately.
          countSkip(importSkips, 'sub-frames-disabled', subFiles.length,
            subFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
            subFiles.map(f => f.name));
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
          const smbSubPath = walkerBase ? `${walkerBase}/${obj.subFolderName}` : obj.subFolderName;
          try {
            debugLog('import:discover', `SeeStar: listing sub-frames from ${smbSubPath}`);
            const subEntries = await smbListDir(smbSubPath, profile);
            subFiles = subEntries.filter(e => e.type === 'file' && isSafeRemoteFileName(e.name));
            debugLog('import:discover', `SeeStar: ${subFiles.length} sub-file(s) in ${smbSubPath}`);
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err), objectName, smbSubPath }, '[import] sub-frame listing failed; continuing without sub-frames for this object');
          }
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
        if (!decision.import) { filteredType++; countSkip(importSkips, decision.reason, 1, f.size ?? 0, [f.originalName ?? f.localName]); return false; }
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
      // Snapshotted now, before this object's own index entry is overwritten
      // further down: it's the "did this night already have a session"
      // signal for the touched-sessions summary below, sourced for free from
      // the index already loaded rather than an extra DB query.
      const priorSessionDates = new Set(index.objects[objIdNormalized]?.sessions ?? []);
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
      // Accumulated per object, flushed in one transaction after the download
      // pool — one fsync for the whole object instead of one per file.
      const pendingFileRows: RecordFileInput[] = [];

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
      /** Note this object as touched by the run (deduped, first call wins the
       *  isNew flag) — called only when a file actually lands, so an object
       *  with nothing new to pull never appears. */
      const recordTouchedObject = (): void => {
        if (!importObjectsTouched.has(objIdNormalized)) {
          importObjectsTouched.set(objIdNormalized, { objectId: objIdNormalized, name: objectName, isNew: !hasPriorImport });
        }
      };
      /** Same idea for the observing night: isNew reflects whether this
       *  object+date combination existed before this run started. */
      const recordTouchedSession = (date: string): void => {
        const sessionKey = `${objIdNormalized}|${date}`;
        if (!importSessionsTouched.has(sessionKey)) {
          importSessionsTouched.set(sessionKey, {
            objectId: objIdNormalized,
            objectName,
            date,
            isNew: !priorSessionDates.has(date),
          });
        }
      };
      /** Record the per-file row. `date` from the walker is an observing night
       *  (already rolled), not a raw capture instant, so it is only pinned as
       *  an override when the filename itself yields no date to derive from —
       *  passing a rolled night in as captureDate would roll it a second time
       *  on every read. Same rule the backfill uses. */
      const recordFile = (file: ImportFile, bytes: number): void => {
        const parsed = parseFilename(file.localName);
        pendingFileRows.push({
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
        debugLog('import:file', `Downloading: ${objectName}/${destRel}${file.size != null ? ` (${(file.size / 1024).toFixed(0)} KB)` : ''}`);
        const outcome = await writeFileIntoLibrary(
          { source: file.remotePath, destRel, expectedSize: file.size, sourceKind: 'transport' },
          { profile, objectDir: objLocalDir, thumbnailQueue },
        );

        if (outcome.status === 'error') {
          downloadErrors++;
          if (!firstDownloadError) firstDownloadError = outcome.reason;
          debugLog('import:error', `Download failed: ${objectName}/${file.localName} — ${outcome.reason}`);
          console.error(`Download failed: ${file.localName}:`, outcome.reason);
          importStatus.filesDone++;
          importStatus.currentObjectFilesDone++;
          importStatus.bytesDone += file.size || 0;
          return;
        }

        if (outcome.status === 'exists') {
          debugLog('import:file', `Skip (exists): ${objectName}/${destRel}`);
          importStatus.filesDone++;
          importStatus.currentObjectFilesDone++;
          importStatus.skippedFiles++;
          importStatus.bytesDone += file.size || 0;
          fileCount++;
          // Still record it: a re-run is how files imported before this table
          // existed acquire a row without waiting for the boot backfill.
          recordFile(file, outcome.bytes);
          if (file.date) {
            sessionSet.add(file.date);
          } else if (/\.jpe?g$/i.test(file.localName)) {
            const d = exifDateFromFile(outcome.localPath);
            if (d) sessionSet.add(d);
          }
          return;
        }

        // outcome.status === 'new'
        const { localPath, bytes } = outcome;
        debugLog('import:file', `Saved: ${objectName}/${destRel} (${(bytes / 1024).toFixed(0)} KB)`);
        fileCount++;
        importStatus.filesDone++;
        importStatus.currentObjectFilesDone++;
        importStatus.bytesDone += bytes;
        importNewFiles.push({ name: `${objectName}/${destRel}`, size: bytes });
        importBytesNew += bytes;
        recordTouchedObject();
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

        if (file.date) {
          sessionSet.add(file.date);
          recordTouchedSession(file.date);
        } else if (/\.jpe?g$/i.test(file.localName)) {
          // Streamed copies never held the bytes in memory — read the EXIF
          // date back off disk instead of a Buffer we don't have.
          const d = exifDateFromFile(localPath);
          if (d) { sessionSet.add(d); recordTouchedSession(d); }
        }
      };

      // Fetch with concurrency 2 within each object over SMB (SeeStar's SMB
      // server is weak and chokes on more parallel requests than that) or
      // FTP (Dwarf's transport already serializes every operation against a
      // target through its own connection queue — see the `queues` map in
      // smb.ftp.ts — so raising this wouldn't add real overlap there and
      // isn't worth the risk of surprising it). A local USB mount has
      // neither bottleneck: a plugged-in drive can comfortably serve more
      // parallel reads, and 2 needlessly throttled large USB imports.
      const DOWNLOAD_CONCURRENCY = profile.connectionType === 'local' ? 6 : 2;
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

      // One transaction for every file row this object produced (new + skipped),
      // written before the object/session rows below so a crash can't leave the
      // object pointing at files with no row — the same order as before, just
      // batched.
      recordLibraryFiles(pendingFileRows);

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
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), objectName }, '[import] existing-local file count failed; fileCount may undercount pre-existing files');
      }

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
          // The synthetic Star Trails object has no catalog entry, so
          // resolveCatalogMeta above just wrote generic placeholders
          // ('Unknown' type, empty description) that upsertObject's own
          // COALESCE would never revisit on a later re-import. Patch it on
          // every import instead — it writes the same fixed constants each
          // time, so this also self-heals any row created before this patch
          // existed.
          if (objId === getStartrailsObjectId()) {
            patchStartrailsObjectMeta(objId);
          }
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
      } catch (err) {
        // This write is the audit trail itself, so its own failure needs to
        // be visible rather than silently discarded along with it.
        log.warn({ err: err instanceof Error ? err.message : String(err), objectId: objId }, '[import] session import log write failed');
      }

      // Mirror the rows next to the files so this object can be rebuilt
      // without the database. Best-effort by design (see writeObjectManifest).
      writeObjectManifest(objId, objFolderName);

      importStatus.objectsDone++;
    }

    // RESTACKED: DWARFLAB's cloud-combined MegaStack (or a Siril/PixInsight
    // restack synced back down) of an existing target — tied to an object,
    // not to any single observation. Runs after the per-target loop above so
    // a target this same sync just created from ordinary session folders is
    // already in `index.objects` and counts as a match.
    //
    // Candidates are collected for the WHOLE RESTACKED tree up front (exactly
    // like calibration frames), then only the files actually turned into
    // processed images are subtracted from what gets archived — rather than
    // assuming every file lives one level down inside a per-stack subfolder.
    // Real layout is unverified, and a loose file sitting directly in
    // RESTACKED/ must still be preserved as bytes, never silently dropped —
    // but a subfolder that resolves to a target id (however it resolves) now
    // gets an object created for it via ensureRestackObject rather than being
    // archived just because nothing imported that target yet. See
    // ensureRestackObject's own doc for why "existing object required" was
    // dropped as a gate.
    if (isDwarf && !importCancelRequested) {
      importStatus.currentObject = 'RESTACKED (MegaStack)';
      try {
        await migrateRestackedToSharedRootOnce();
        const restackedPath = path.posix.join(walkerBase, RESTACKED_FOLDER);
        const allCandidates = await collectRemoteArchiveCandidates(profile, walkerBase, [RESTACKED_FOLDER]);
        const matchedRelPaths = new Set<string>();
        // Derive the subfolder set and each subfolder's file list from
        // allCandidates: collectRemoteArchiveCandidates already walked the
        // entire RESTACKED tree just above. Re-listing the root and then every
        // subfolder a second time doubled this pass's listing latency on every
        // import (including every scheduled auto-import tick), and over FTP —
        // one serialized control connection — that is the whole cost.
        const filesBySubfolder = new Map<string, Array<{ name: string; size: number; remotePath: string; relPath: string }>>();
        for (const c of allCandidates) {
          const parts = c.relPath.split('/');
          // parts[0] is RESTACKED_FOLDER. Only direct file children of a
          // subfolder are import candidates (matches the old type==='file'
          // filter on a per-subfolder listing). Root-level files and any
          // more-deeply-nested ones stay in allCandidates and fall through to
          // the archive pass below unchanged.
          if (parts.length !== 3 || parts[1].startsWith('.')) continue;
          const list = filesBySubfolder.get(parts[1]) ?? [];
          list.push({ name: parts[2], size: c.size, remotePath: c.remotePath, relPath: c.relPath });
          filesBySubfolder.set(parts[1], list);
        }
        let matched = 0;
        for (const [subName, files] of filesBySubfolder) {
          let shotsInfoTarget: string | null = null;
          if (files.some(f => f.name === SHOTS_INFO_FILENAME)) {
            try {
              const shotsInfoPath = path.posix.join(restackedPath, subName, SHOTS_INFO_FILENAME);
              shotsInfoTarget = targetFromShotsInfo(JSON.parse((await smbGetFile(shotsInfoPath, 65536, profile)).toString('utf8')));
            } catch { /* shotsInfo.json unreadable/invalid -- fall back to the folder name */ }
          }
          const targetId = resolveRestackTargetId(subName, shotsInfoTarget);
          if (!targetId) continue; // nothing plausible to name an object after — stays in allCandidates, archived below
          // shotsInfo.json carries no date, only RA/DEC/target — the capture
          // night lives in the subfolder's own trailing timestamp instead
          // (e.g. "..._20250709-010411632"), same token every file inside it
          // shares. Null when the name doesn't carry one; that's the old
          // "No specific session" behavior, not a regression.
          const restackDate = extractDateFromSessionFolder(subName);

          // Dwarf queues a RESTACKED subfolder before it has anything in it —
          // an interrupted/still-running restack leaves an empty directory
          // with no shotsInfo.json to resolve against. Nothing to attach to
          // an object yet, so don't create one from an empty folder's name:
          // ensureRestackObject only runs once there's a real file in hand.
          const hasImportableFile = files.some(f =>
            (isRenderableProcessedName(f.name) || isStoredOnlyProcessedName(f.name)) && !isDwarfThumbnailPreviewName(f.name));
          if (!hasImportableFile) continue; // stays in allCandidates, archived below (usually nothing — empty dir)
          ensureRestackObject(targetId, index, profile.id);
          for (const f of files) {
            if (!isRenderableProcessedName(f.name) && !isStoredOnlyProcessedName(f.name)) continue;
            // Dwarf's redundant low-res preview of stacked.jpg -- never worth
            // a processed-image row. Leave it unmatched so it still lands in
            // the archive with everything else, bytes preserved either way.
            if (isDwarfThumbnailPreviewName(f.name)) continue;
            const relPath = f.relPath;
            if (hasRestackedImage(targetId, f.name)) { matchedRelPaths.add(relPath); continue; } // already imported on a prior sync
            const tmpPath = path.join(IMPORT_TMP_BASE, `restack_${randomUUID()}_${path.basename(f.name)}`);
            try {
              await fs.promises.mkdir(IMPORT_TMP_BASE, { recursive: true });
              await copyTransportFile(f.remotePath, tmpPath, profile);
              addProcessedImage(targetId, restackDate, tmpPath, f.name, mimeTypeForExtension(f.name), subName, '', null, 'dwarf-restack');
              matched++;
              matchedRelPaths.add(relPath);
            } catch (err) {
              log.warn({ err: err instanceof Error ? err.message : String(err), folder: subName, file: f.name }, '[import] RESTACKED file failed; skipping');
              try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
            }
          }
        }
        const toArchive = allCandidates.filter(c => !matchedRelPaths.has(c.relPath));
        if (toArchive.length > 0) {
          // relPath already comes back "RESTACKED/<subfolder>/<file>" (see
          // collectRemoteArchiveCandidates's folders param below), so the
          // destination root is the library root itself, not
          // getRestackArchiveDir() — that would double up the RESTACKED
          // segment. getRestackArchiveDir() is for callers that just want
          // the resolved path (e.g. import status reporting).
          await downloadToArchive(profile, toArchive, getLibraryDir(), { shouldCancel: () => importCancelRequested });
        }
        debugLog('import:dwarf', `RESTACKED: ${matched} file(s) matched to an object, ${toArchive.length} file(s) archived (no matching object)`);
      } catch {
        // No RESTACKED folder on this device/model, or listing it failed —
        // identical to "none found", never surfaced as an import error.
        debugLog('import:dwarf', 'RESTACKED folder not present or unreadable — skipping');
      }
    }

    // Calibration frames: CALI_FRAME/DWARF_DARK are specific to the physical
    // telescope unit and are never observations of anything, so they are
    // pulled straight into the archive rather than the object model — same
    // non-destructive philosophy as the folder-import wizard's archive mode
    // (archiveFolders.ts), just reachable over the live transport instead of
    // local disk. Unlike the wizard, this runs on every sync,
    // unconditionally: a folder-import user has to opt into "archive
    // everything", but a live-synced Dwarf's calibration data has nowhere
    // else to go and no reason to be left behind.
    if ((isDwarf || isAsiair) && !importCancelRequested) {
      importStatus.currentObject = 'Calibration frames';
      try {
        // ASIAIR keeps its calibration under the capture-mode folders
        // (Autorun/Dark, Plan/Flat, ...) with no target of their own, which is
        // the same situation as Dwarf's CALI_FRAME and gets the same answer.
        // Its base is the resolved ASIAIR root rather than walkerBase, which is
        // '' for this kind: removable media nests the tree under `ASIAir/`.
        const archiveBase = isAsiair ? await resolveAsiairRoot(profile) : walkerBase;
        const archiveFolders = isAsiair ? ASIAIR_CALIBRATION_PATHS : ['CALI_FRAME', 'DWARF_DARK'];
        // Not every device has every folder; collectRemoteArchiveCandidates
        // lists each independently and simply finds nothing for one that's
        // absent (smbListDir returns an empty listing for a missing remote
        // directory rather than throwing, matching SMB/local semantics).
        const candidates = await collectRemoteArchiveCandidates(profile, archiveBase, archiveFolders);
        if (candidates.length > 0) {
          const archived = await downloadToArchive(profile, candidates, getArchiveDir(profile.id), {
            shouldCancel: () => importCancelRequested,
          });
          debugLog('import:dwarf', `Calibration archive: ${archived.copied} new, ${archived.alreadyPresent} already archived, ${archived.failed} failed`);
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, '[import] calibration archive pass failed; continuing');
      }
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

    // Enrich with Wikipedia description + SIMBAD size data. Best-effort network
    // call; enrichObjectData internally checks whether the object is already
    // fully enriched and returns immediately if so.
    for (const objectId of touchedObjectIds) {
      try {
        debugLog('import:object', `${objectId}: enriching catalog data`);
        await enrichObjectData(objectId);
        debugLog('import:object', `${objectId}: enrichment complete`);
      } catch {
        debugLog('import:object', `${objectId}: enrichment failed (non-fatal)`);
      }
      // Weather is queued, not awaited — a slow archive API for a 25-night
      // object used to add minutes to import completion (FC-3).
      try { enqueueSessionWeatherBackfill(objectId); } catch { /* best-effort */ }
    }

    // Pre-warm the gallery thumbnail cache for every object that received new
    // files so the library grid loads instantly on first view.
    if (importNewFiles.length > 0) {
      const newObjectIds = new Set(importNewFiles.map(f => resolveCanonicalId(normalizeObjectId(f.name.split('/')[0]))));
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
    // Save history record + system-log summary (one writer for all four paths).
    writeImportHistory(importStatus, {
      newFiles: importNewFiles,
      bytesNew: importBytesNew,
      objectsTouched: importObjectsTouched,
      sessionsTouched: importSessionsTouched,
      source: 'telescope',
    });
    // New images may have landed; drop the gallery walk cache so they appear
    // on the next /all-images call instead of waiting out the TTL.
    if (importNewFiles.length > 0) invalidateAllImagesCache();
    importStatus.running = false;
    importStatus.currentObject = null;
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    try { stmts.setImportRunning.run(0, null); } catch (err) {
      console.warn('[import] setImportRunning failed:', err instanceof Error ? err.message : err);
    }
  }
  } finally {
    releaseImportLock(myRunId);
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
  // See runImport's matching declaration for why this is captured and passed
  // to releaseImportLock().
  let myRunId: string | null = null;
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
    filesErrored: 0,
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
  myRunId = importStatus.runId;

  // Own the shared run accumulators unless this call is one night of a
  // whole-object roll-up (syncObjectSubFrames resets once and writes the
  // single history row itself).
  if (!options?.rollup) {
    importNewFiles = [];
    importBytesNew = 0;
    importObjectsTouched = new Map();
    importSessionsTouched = new Map();
    importSkips = new Map();
  }

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
  currentImportWalker = getWalkerConfig(profile.kind);
  const walkerBase = currentImportWalker.basePath;
  const isDwarf = isDwarfKind(profile.kind);
  const isGeneric = profile.kind === 'other';
  const isAsiair = isAsiairKind(profile.kind);
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

    // Generic SMB Layout: tried first (for kind 'other' only) so a matching
    // nested session takes priority, but a source with no matching nested
    // session — including the pre-existing "any SMB share" flat layout,
    // which has no session folders at all — falls through to the flat
    // SeeStar-style `_sub` lookup below instead of erroring here.
    let genericMatch: { obj: GenericDiscoveredObject; sessions: string[] } | null = null;
    if (isGeneric) {
      debugLog('subframe-sync:discover', `Generic: scanning for sub-frames of "${targetObjectId}" on ${targetDate}`);
      const discovered = await discoverGenericObjects(profile);
      const obj = discovered.find(o => resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId);
      // Session folders are <YYYY-MM-DD>_<HHMM> by construction, so the date
      // is always the first 10 characters — same rule runImport applies.
      const sessions = (obj?._genericSessionFolders ?? []).filter(s => s.slice(0, 10) === targetDate);
      if (obj && sessions.length > 0) {
        genericMatch = { obj, sessions };
      } else {
        debugLog('subframe-sync:discover', `Generic: no session folder found for "${targetObjectId}" on ${targetDate} — falling back to flat layout`);
      }
    }

    if (isAsiair) {
      // ASIAIR has no _sub companion folder and no session folders: the light
      // frames under Autorun|Plan/Light/<Target> are the sub-frames, and the
      // night comes from each filename's own timestamp.
      debugLog('subframe-sync:discover', `ASIAIR: scanning for sub-frames of "${targetObjectId}" on ${targetDate}`);
      const discovered = await discoverAsiairObjects(profile);
      // Resolve aliases the same way the branches below do: the device's folder
      // name is a raw target string that may differ from the canonical id once
      // catalog aliasing is applied.
      const obj = discovered.find(o => resolveCanonicalId(normalizeObjectId(o.folderName)) === targetObjectId);
      if (!obj) {
        debugLog('subframe-sync:discover', `ASIAIR: no target folder found for "${targetObjectId}"`);
        importStatus.error = `${profile.name} has no ASIAIR frames for "${targetObjectId}". Capture the object first, then sync.`;
        return;
      }
      const { subFiles } = await listAsiairObjectFiles(profile, obj);
      debugLog('subframe-sync:discover', `ASIAIR: ${subFiles.length} frame(s) found for "${targetObjectId}"`);
      candidates = subFiles
        .filter(e => /\.f(?:it|its|ts)$/i.test(e.name))
        .map((e): SubFrameCandidate | null => {
          const basename = asiairLocalName(e.name);
          if (!isSafeRemoteFileName(basename)) return null;
          const night = sessionNightFor(parseFilename(basename));
          if (night !== targetDate) return null;
          return {
            remotePath: buildAsiairFilePath(e.name),
            // Names are unique across capture modes and nights on their own, so
            // nothing is prefixed here even for a flat object. Mirrors
            // runImport's ASIAIR branch, which does not rename either.
            localName: basename,
            originalName: basename,
            size: e.size,
            sessionFolder: objectLayout === 'nested' ? sessionFolderFor(null, night, null) : null,
          };
        })
        .filter((c): c is SubFrameCandidate => c !== null);
      debugLog('subframe-sync:discover', `ASIAIR: ${candidates.length} sub-frame candidate(s) matching date ${targetDate}`);
    } else if (isDwarf) {
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
        _dwarfSessionBase: obj._dwarfSessionBase,
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
              remotePath: buildDwarfFilePath(e.name, obj._dwarfSessionBase),
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
            remotePath: buildDwarfFilePath(e.name, obj._dwarfSessionBase),
            localName: named.name,
            originalName: basename,
            size: e.size,
            sessionFolder: null,
          };
        });
      candidates = mapped.filter((c): c is SubFrameCandidate => c !== null);
      debugLog('subframe-sync:discover', `Dwarf: ${candidates.length} sub-frame candidate(s) after date filtering`);
    } else if (genericMatch) {
      const { obj, sessions } = genericMatch;
      const { subFiles } = await listGenericObjectFiles(profile, {
        folderName: obj.folderName,
        subFolderName: null,
        _genericSessionFolders: sessions,
      });
      debugLog('subframe-sync:discover', `Generic: ${subFiles.length} sub-file(s) found for ${targetDate}`);
      candidates = subFiles
        .map((e): SubFrameCandidate | null => {
          const parts = e.name.split('/');
          const session = parts[0];
          const basename = parts[parts.length - 1];
          if (!isSafeRemoteFileName(basename)) return null;
          // Flat layout: prefix the session so files from different sessions
          // never collide in the one flat directory, matching runImport's
          // own generic-flat naming.
          return {
            remotePath: buildGenericFilePath(obj, e.name),
            localName: objectLayout === 'nested' ? basename : `${session}_${basename}`,
            originalName: basename,
            size: e.size,
            sessionFolder: objectLayout === 'nested' ? sessionFolderFor(session, session.slice(0, 10), null) : null,
          };
        })
        .filter((c): c is SubFrameCandidate => c !== null);
      debugLog('subframe-sync:discover', `Generic: ${candidates.length} sub-frame candidate(s) after filtering`);
    } else {
      debugLog('subframe-sync:discover', `SeeStar: listing ${walkerBase} for sub-frame folders`);
      const entries = await smbListDir(walkerBase, profile);
      const subFolders = entries.filter(e => e.type === 'dir' && isSubFolder(e.name));
      debugLog('subframe-sync:discover', `SeeStar: ${subFolders.length} sub-folder(s) found`);
      // Resolve aliases the same way the Dwarf/Generic branches above (and
      // runImport's toImport filter) do: the device's `_sub` folder is named
      // for the raw target string (e.g. "C 30"), which may differ from the
      // canonical id this sync was asked for (e.g. "NGC7331") once catalog
      // aliasing is applied. Without resolveCanonicalId here, sub-frame sync
      // for any alias-folded object silently found no match and synced nothing.
      const subFolder = subFolders.find(
        s => resolveCanonicalId(normalizeObjectId(getObjectFromSubFolder(s.name))) === targetObjectId,
      );
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
    const objFolderName = path.basename(objLocalDir);
    // A sub-frame sync only ever touches an object + night that already exist,
    // so `isNew` is always false. Populated so the run lands in Sync History
    // (High-4) with the same touched-objects/sessions detail every other path
    // records.
    const noteTouched = (): void => {
      if (!importObjectsTouched.has(targetObjectId)) {
        importObjectsTouched.set(targetObjectId, { objectId: targetObjectId, name: objFolderName, isNew: false });
      }
      const sessionKey = `${targetObjectId}|${targetDate}`;
      if (!importSessionsTouched.has(sessionKey)) {
        importSessionsTouched.set(sessionKey, { objectId: targetObjectId, objectName: objFolderName, date: targetDate, isNew: false });
      }
    };

    // Same worker-pool + shared FITS-thumbnail queue as runImport's downloadOne.
    // This path used to download one frame at a time and then thumbnail them all
    // one at a time, which for the hundreds of raw frames it exists to move made
    // it the slowest path in the app — and the one users watch a progress bar
    // for (CORE-PIPELINE-AUDIT High-3).
    const thumbnailQueue = createWorkerQueue<string>(4, async localPath => {
      await generateFitsThumbnail(localPath).catch(err =>
        console.warn(`[thumb] ${path.basename(localPath)}:`, err instanceof Error ? err.message : err),
      );
    });

    const DOWNLOAD_CONCURRENCY = profile.connectionType === 'local' ? 6 : 2;
    const downloadQueue = toDownload.slice();
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
      while (downloadQueue.length > 0) {
        if (importCancelRequested) break;
        const file = downloadQueue.shift();
        if (!file) break;
        const destRel = destRelFor(file);
        debugLog('subframe-sync:file', `Downloading: ${file.localName}${file.size != null ? ` (${(file.size / 1024).toFixed(0)} KB)` : ''}`);
        const outcome = await writeFileIntoLibrary(
          { source: file.remotePath, destRel, expectedSize: file.size, sourceKind: 'transport' },
          { profile, objectDir: objLocalDir, thumbnailQueue },
        );
        if (outcome.status === 'error') {
          downloadErrors++;
          importStatus.filesErrored = (importStatus.filesErrored ?? 0) + 1;
          debugLog('subframe-sync:error', `Download failed: ${file.localName} — ${outcome.reason}`);
          console.error('Sub-frame download failed: %s:', file.localName, outcome.reason);
        } else {
          debugLog('subframe-sync:file', `Saved: ${file.localName} (${(outcome.bytes / 1024).toFixed(0)} KB)`);
          if (outcome.status === 'new') {
            importNewFiles.push({ name: `${objFolderName}/${destRel}`, size: outcome.bytes });
            importBytesNew += outcome.bytes;
            noteTouched();
          }
        }
        // Counts every attempt, success or fail, so the progress bar reaches
        // 100%. syncObjectSubFrames subtracts filesErrored for its real total.
        importStatus.filesDone++;
      }
    }));
    thumbnailQueue.close();
    await thumbnailQueue.drain();

    if (importCancelRequested) {
      importStatus.error = 'Sub-frame sync cancelled. Files already downloaded were kept; the rest will be picked up on the next run.';
      importStatus.cancelled = true;
      return;
    }

    if (downloadErrors > 0) {
      importStatus.error = `${downloadErrors} of ${toDownload.length} sub-frame downloads failed. Check that ${profile.name} stayed reachable and try the sync again.`;
    }

    // Record every candidate that is on disk, not just the ones downloaded on
    // this run, so a re-sync gives rows to sub-frames pulled down before this
    // table existed. Roles are 'sub' by construction: this whole path only
    // ever handles raw frames.
    {
      const subFrameRows: RecordFileInput[] = [];
      for (const file of candidates) {
        const localPath = path.join(objLocalDir, destRelFor(file));
        let bytes = file.size ?? 0;
        if (!fs.existsSync(localPath)) continue;
        if (!bytes) {
          try { bytes = fs.statSync(localPath).size; } catch { /* best effort */ }
        }
        const parsed = parseFilename(file.localName);
        subFrameRows.push({
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
      recordLibraryFiles(subFrameRows);
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
              stmts.addSessionTombstone.run(targetObjectId, date, new Date().toISOString());
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

    // Land in Sync History like every other import path (High-4). Suppressed
    // for a night driven by syncObjectSubFrames, which writes one roll-up row.
    if (!options?.rollup) {
      importStatus.skipped = summarizeSkips(importSkips);
      writeImportHistory(importStatus, {
        newFiles: importNewFiles,
        bytesNew: importBytesNew,
        objectsTouched: importObjectsTouched,
        sessionsTouched: importSessionsTouched,
        source: 'subframe',
      });
    }
  } catch (err) {
    importStatus.error = friendlyImportError(err, profile);
  } finally {
    importStatus.running = false;
    importStatus.currentObject = null;
    importStatus.telescopeId = null;
    importStatus.telescopeName = null;
    importStatus.objectsDone = 1;
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
  }
  } finally {
    releaseImportLock(myRunId);
  }
}

/**
 * syncSessionSubFrames reports "this night has no _sub companion folder / no
 * device session folder for this date" by setting importStatus.error (see
 * import.ts ~2225 / ~2251 / ~2358). For a whole-object sweep that is not a
 * failure: the telescope just was not saving sub-frames that night. Matched on
 * stable fragments of those messages so such nights are counted as skipped
 * rather than surfaced as an error.
 */
function isNoSubFramesForNight(message: string): boolean {
  return message.includes('has no sub-frame folder for')
    || message.includes('has no Dwarf session folder');
}

/**
 * Sync raw sub-frames for EVERY session of one object from the telescope, by
 * running syncSessionSubFrames once per night.
 *
 * Lock model mirrors runAllTelescopesImport: the caller (route) claims the lock
 * for the first night, each syncSessionSubFrames releases it in its own
 * finally, and this re-claims before the next night. If the auto-import
 * scheduler wins a between-nights re-claim, the remaining nights are reported
 * as skipped and picked up next time.
 *
 * Each night is synced against the telescope that captured it
 * (getSessionTelescopeId), so an object shot across two rigs still pulls each
 * night's sub-frames from the right device.
 *
 * While the run is active importStatus reflects the night currently syncing
 * (its counters reset to 0 per night, same as a single-session sync). Once the
 * loop finishes it is overwritten once with the run total so a client's
 * end-of-run check (filesDone === 0 → "nothing new") sees real numbers.
 */
export async function syncObjectSubFrames(
  targetObjectId: string,
  options?: RunImportOptions,
): Promise<void> {
  const canonicalId = resolveCanonicalId(normalizeObjectId(targetObjectId));

  let dates: string[];
  try {
    const meta = loadIndex().objects[canonicalId];
    const deleted = new Set(meta?.deletedSessions ?? []);
    dates = [...new Set(meta?.sessions ?? [])].filter(d => !deleted.has(d)).sort();
  } catch (err) {
    console.error('[subframe-sync] Failed to read library index:', err instanceof Error ? err.message : err);
    importStatus.error = "Could not read the library to find this object's nights. Check the server logs and try again.";
    importStatus.running = false;
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
    releaseImportLock();
    return;
  }

  if (dates.length === 0) {
    // Present a finished, empty run so the client's modal resolves cleanly
    // instead of hanging on "connecting".
    importStatus = {
      ...importStatus,
      running: false,
      runId: randomUUID(),
      currentObject: null,
      telescopeId: null,
      telescopeName: null,
      transportKind: null,
      objectsTotal: 0,
      objectsDone: 0,
      filesTotal: 0,
      filesDone: 0,
      skippedFiles: 0,
      skipped: [],
      error: null,
      cancelled: false,
      startedAt: new Date().toISOString(),
      manual: true,
    };
    try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ }
    releaseImportLock();
    return;
  }

  log.info({ objectId: canonicalId, nights: dates.length }, '[subframe-sync] Syncing sub-frames for all %d nights of %s', dates.length, canonicalId);

  // Own the shared accumulators for the whole sweep: each night runs with
  // `rollup: true` so it adds to these without resetting, and this writes the
  // single Sync History row at the end.
  const runStartedAt = new Date().toISOString();
  importNewFiles = [];
  importBytesNew = 0;
  importObjectsTouched = new Map();
  importSessionsTouched = new Map();
  importSkips = new Map();

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let nightsWithoutSubs = 0;
  let cancelled = false;
  const errors: string[] = [];

  for (let i = 0; i < dates.length; i++) {
    // The lock is held (by the route) on the first pass; syncSessionSubFrames
    // released it in its finally on every pass after that, so re-claim.
    if (i > 0 && !claimImportLock()) {
      appendImportStatusError(
        `Sub-frame sync stopped after ${i} of ${dates.length} nights: another import claimed the lock. Run it again to finish ${dates.slice(i).join(', ')}.`,
      );
      return;
    }

    const telescopeId = options?.telescopeId ?? getSessionTelescopeId(canonicalId, dates[i]) ?? undefined;
    try {
      await syncSessionSubFrames(canonicalId, dates[i], { ...(options ?? {}), telescopeId, rollup: true });
    } catch (err) {
      errors.push(`${dates[i]}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // filesDone counts every attempt this night; subtract the failures so a
    // night where every frame 404s contributes 0, not "downloaded N files".
    totalDownloaded += Math.max(0, importStatus.filesDone - (importStatus.filesErrored ?? 0));
    totalSkipped += importStatus.skippedFiles;
    if (importStatus.cancelled) { cancelled = true; break; }
    const nightError = importStatus.error;
    if (nightError) {
      // A night with no sub-frames on the telescope is skipped, not an error.
      if (isNoSubFramesForNight(nightError)) nightsWithoutSubs++;
      else errors.push(`${dates[i]}: ${nightError}`);
    }
  }

  // syncSessionSubFrames released the lock in its own finally on the last pass.
  // Re-claim just long enough to publish the run total so a client polling
  // right now sees consistent final numbers and the DB row is left clean.
  const reclaimed = claimImportLock();
  const noneHadSubs = totalDownloaded === 0 && totalSkipped === 0 && errors.length === 0 && !cancelled;
  importStatus = {
    ...importStatus,
    running: false,
    currentObject: null,
    telescopeId: null,
    telescopeName: null,
    transportKind: null,
    objectsTotal: dates.length,
    objectsDone: dates.length,
    filesTotal: totalDownloaded,
    filesDone: totalDownloaded,
    // When nothing was downloaded and nothing was already present, leave both
    // counters at 0 with no error so the client shows its plain "no sub-frames
    // found for this object" state instead of a red failure.
    skippedFiles: noneHadSubs ? 0 : totalSkipped,
    skipped: [],
    error: errors.length > 0
      ? [...new Set(errors)].join('; ')
      : cancelled
        ? 'Sub-frame sync cancelled. Nights already synced were kept; the rest will be picked up next time.'
        : null,
    cancelled,
    startedAt: runStartedAt,
    lastRun: new Date().toISOString(),
  };
  if (nightsWithoutSubs > 0 && !noneHadSubs) {
    log.info(
      { objectId: canonicalId, nightsWithoutSubs, downloaded: totalDownloaded },
      '[subframe-sync] %d of %d nights had no sub-frames on the telescope and were skipped',
      nightsWithoutSubs, dates.length,
    );
  }

  // One Sync History entry for the whole "sync all sub-frames" run.
  writeImportHistory(importStatus, {
    newFiles: importNewFiles,
    bytesNew: importBytesNew,
    objectsTouched: importObjectsTouched,
    sessionsTouched: importSessionsTouched,
    source: 'subframe',
  });

  if (reclaimed) releaseImportLock();
  else { try { stmts.setImportRunning.run(0, null); } catch { /* best-effort */ } }
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
        if (!isRecord(entry)) continue;
        const { reason, count, bytes, samples } = entry;
        if (typeof reason !== 'string' || typeof count !== 'number') continue;
        if (!isImportSkipReason(reason)) continue;
        // History rows written before sizes were tallied have no `bytes`; 0 reads
        // as "not measured" and the UI omits the size rather than showing "0 B".
        // `samples` is absent on rows written before this field existed.
        const sampleNames = Array.isArray(samples)
          ? samples.filter((s): s is string => typeof s === 'string')
          : undefined;
        countSkip(tally, reason, count, typeof bytes === 'number' ? bytes : 0, sampleNames);
      }
      const summary = summarizeSkips(tally);
      return summary.length > 0 ? summary : null;
    } catch {
      return null;
    }
  };
  // Same narrowing pattern: validate shape field-by-field instead of trusting
  // what a past version of this code (or a hand-edited DB) put in the column.
  const parseObjectsTouched = (raw: string | null): TouchedObject[] | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const result: TouchedObject[] = [];
      for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const { objectId, name, isNew } = entry;
        if (typeof objectId !== 'string' || typeof name !== 'string' || typeof isNew !== 'boolean') continue;
        result.push({ objectId, name, isNew });
      }
      return result.length > 0 ? result : null;
    } catch {
      return null;
    }
  };
  const parseSessionsTouched = (raw: string | null): TouchedSession[] | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const result: TouchedSession[] = [];
      for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        const { objectId, objectName, date, isNew } = entry;
        if (typeof objectId !== 'string' || typeof objectName !== 'string' || typeof date !== 'string' || typeof isNew !== 'boolean') continue;
        result.push({ objectId, objectName, date, isNew });
      }
      return result.length > 0 ? result : null;
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
      objectsTouched: parseObjectsTouched(r.objectsTouched),
      sessionsTouched: parseSessionsTouched(r.sessionsTouched),
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
 *
 * `runId`, when passed, must match the run currently holding the lock
 * (`importStatus.runId`) or this is a no-op. Without it, a run that was
 * force-released as stale by the watchdog (see forceReleaseStaleLock) but is
 * still executing a hung await can wake up later, reach its own finally
 * block, and release a *different*, newer run's lock out from under it —
 * `importStatus` is a single shared mutable object, so by then it may belong
 * entirely to that newer run. Callers that never mint their own runId (e.g.
 * the pre-loop early-return paths in runAllTelescopesImport, or a synchronous
 * claim/release pair with no intervening await) omit the argument and keep
 * the old unconditional behavior, since there's no ownership race for them
 * to guard against.
 */
export function releaseImportLock(runId?: string | null): void {
  if (runId !== undefined && importStatus.runId !== runId) return;
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

  // See runImport's matching declaration for why this is captured and passed
  // to releaseImportLock().
  let myRunId: string | null = null;

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
  myRunId = importStatus.runId;
  importNewFiles = [];
  importBytesNew = 0;
  importObjectsTouched = new Map();
  importSessionsTouched = new Map();
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
    const { sources, excludedFolders, resolvedRoot } = collectObjectSources(rootPath, commitProfile?.kind);

    // Archive mode is a promise about bytes, not about the object model: these
    // folders are copied verbatim into the library's reserved `_archive`
    // directory and never registered as objects. Without this the folder-level
    // exclusion sat upstream of every file-level setting, so "archive
    // everything" silently still dropped calibration frames and restacks. See
    // archiveFolders.ts.
    //
    // Calibration frames (CALI_FRAME/DWARF_DARK) are specific to the physical
    // telescope unit and are never observations of anything, so — like the
    // live-sync path — they are always archived, not gated behind
    // archiveAllFiles: a folder-import user has to opt into "archive
    // everything" for daytime photos and burst captures, but calibration data
    // has nowhere else to go regardless. RESTACKED is handled separately,
    // after the main object loop below (matched subfolders become processed
    // images instead of archived bytes); `restackedFolderName` is carved out
    // here so it isn't double-archived by the "everything else" pass.
    const CALIBRATION_FOLDER_NAMES = ['cali_frame', 'dwarf_dark'];
    const calibrationFolderNames = excludedFolders.filter(f => CALIBRATION_FOLDER_NAMES.includes(f.toLowerCase()));
    const restackedFolderName = excludedFolders.find(f => isRestackedFolder(f)) ?? null;
    const otherExcludedFolders = excludedFolders.filter(
      f => !CALIBRATION_FOLDER_NAMES.includes(f.toLowerCase()) && f !== restackedFolderName,
    );
    const archiveCandidates = [
      ...collectArchiveCandidates(resolvedRoot, calibrationFolderNames),
      ...(settings.archiveAllFiles === true ? collectArchiveCandidates(resolvedRoot, otherExcludedFolders) : []),
    ];
    const planByFolder = new Map<string, CommitObjectPlan>();
    for (const p of plan.objects) planByFolder.set(p.folderName, p);

    /** Sources the user kept, each paired with the plan that selected it. The
     *  pairing is built here rather than re-looked-up in the copy loop below:
     *  a second `planByFolder.get()` there would hand back `undefined` as far
     *  as the compiler is concerned, and the only way to use it would be to
     *  assert the lookup can't miss. Carrying the plan forward proves it. */
    const active: Array<{ source: ObjectSource; objPlan: CommitObjectPlan }> = [];
    for (const s of sources) {
      const p = planByFolder.get(s.folderName);
      if (p && !p.skip) active.push({ source: s, objPlan: p });
    }
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
    //
    // The walk result rides along with each entry (rather than living in a
    // side map keyed by source) so the copy loop below reads it by
    // destructuring instead of a lookup it would then have to assert on.
    const walked: Array<{ source: ObjectSource; objPlan: CommitObjectPlan; files: WalkedFile[] }> = [];
    let plannedBytes = 0;
    let largestFileBytes = 0;
    // scanImportFolder surfaces this same per-object cap (MAX_FILES_PER_OBJECT
    // in folderScan.ts) via ScanResult.truncated and the wizard warns the user
    // before they commit. This loop used to destructure the walk result and
    // drop `truncated` on the floor, so an object over the cap imported its
    // first 50k files and reported plain success with no sign anything was
    // left behind.
    const truncatedFolders: string[] = [];
    for (const { source, objPlan } of active) {
      const { files, skipped: walkSkips, truncated: sourceTruncated } = walkObjectFiles(source, settings);
      for (const [reason, v] of walkSkips) countSkip(importSkips, reason, v.count, v.bytes, v.samples);
      if (sourceTruncated) truncatedFolders.push(source.folderName);
      walked.push({ source, objPlan, files });
      importStatus.filesTotal += files.length;
      for (const f of files) {
        plannedBytes += f.size;
        if (f.size > largestFileBytes) largestFileBytes = f.size;
      }
    }
    // Archived files count toward the run's size for both the progress bar and
    // the free-space preflight below. They are real copies onto the library
    // volume and leaving them out of the total would under-reserve exactly the
    // case where the user asked for the most data.
    for (const candidate of archiveCandidates) {
      importStatus.filesTotal++;
      plannedBytes += candidate.size;
      if (candidate.size > largestFileBytes) largestFileBytes = candidate.size;
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

    for (const { source, objPlan, files } of walked) {
      if (importCancelRequested) {
        importStatus.error = 'Import cancelled. Files already copied were kept; the rest will be picked up on the next run.';
        importStatus.cancelled = true;
        break;
      }
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
      // Bound to a const so the closures below keep the narrowing the block
      // above established: a captured `let` widens back to `string | null`
      // inside a closure body, which is what used to force a `!` there.
      const objectDir: string = objLocalDir;

      log.info(
        { source: source.folderName, targetObjectId, dest: path.basename(objLocalDir) },
        '[folder-import] object',
      );

      // Snapshotted now, before this object's own index entry is overwritten
      // at the end of this iteration — see the telescope import path for the
      // same pattern. Two source folders targeting the same new object within
      // one run correctly report only the first as "new": by the second
      // iteration the index already reflects the first's write.
      const hasPriorImport = !!index.objects[targetObjectId];
      const priorSessionDates = new Set(index.objects[targetObjectId]?.sessions ?? []);
      const touchedObjectName = path.basename(objLocalDir);
      const recordTouchedObject = (): void => {
        if (!importObjectsTouched.has(targetObjectId)) {
          importObjectsTouched.set(targetObjectId, { objectId: targetObjectId, name: touchedObjectName, isNew: !hasPriorImport });
        }
      };
      const recordTouchedSession = (date: string): void => {
        const sessionKey = `${targetObjectId}|${date}`;
        if (!importSessionsTouched.has(sessionKey)) {
          importSessionsTouched.set(sessionKey, {
            objectId: targetObjectId,
            objectName: touchedObjectName,
            date,
            isNew: !priorSessionDates.has(date),
          });
        }
      };

      // `files` was walked once up front (see the pre-pass above), not here:
      // the free-space preflight needs the whole import's byte total before
      // the first file is copied.

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
          try { for (const f of fs.readdirSync(path.join(objectDir, dir))) set.add(f); }
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
      const folderFileRows: RecordFileInput[] = [];
      for (const file of files) {
        if (importCancelRequested) { cancelledMidObject = true; break; }
        const target = resolveTargetDate(objPlan.sessionMap, file.derived.date, file.derived.time);
        if (!target || !ISO_DATE.test(target)) {
          log.info({ file: file.name, derivedDate: file.derived.date ?? null, reason: 'date-dropped' }, '[folder-import] skip');
          // Not counted in skippedFiles: that number is rendered as "already
          // synced", which these files are not. They were dropped.
          countSkip(importSkips, 'date-dropped', 1, 0, [file.name]);
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
        const naturalPath = path.join(objLocalDir, sessionDir, naturalName);
        if (fs.existsSync(naturalPath)) {
          // A prior run's copy can have been interrupted before .tmp staging
          // was added below, leaving a truncated file at the final name.
          // Compare against the known source size so a retry heals it
          // instead of treating a partial file as "already imported" forever.
          let complete = true;
          try { complete = fs.statSync(naturalPath).size === file.size; } catch { complete = false; }
          if (complete) {
            log.info({ file: naturalName, objectId: targetObjectId }, '[folder-import] exists');
            importStatus.skippedFiles++;
            importStatus.filesDone++;
            used.add(naturalName);
            continue;
          }
          log.warn({ file: naturalName, objectId: targetObjectId }, '[folder-import] re-copying partial file from a prior interrupted run');
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
        const tmpDestPath = `${path.join(objLocalDir, destRel)}.tmp`;
        try {
          // Shared write primitive: `.tmp` + rename (so a crash mid-copy can't
          // leave a truncated file the exists-check above treats as "imported"
          // forever), containment guard, and the same partial-file heal every
          // other import path now uses.
          const outcome = await writeFileIntoLibrary(
            { source: file.absPath, destRel, expectedSize: file.size, sourceKind: 'localCopy' },
            { objectDir: objLocalDir },
          );
          if (outcome.status === 'error') throw new Error(outcome.reason);
          const size = outcome.bytes;
          // Release the staged copy now that the library has the file. Done
          // per file rather than by deleting the whole temp dir at the end,
          // which is what made an upload need double its own size in free
          // space for the entire run. Only ever applied to our own staging
          // area, and only after the copy has succeeded.
          if (stagedSource) {
            try { await fs.promises.unlink(file.absPath); } catch { /* swept later */ }
          }
          importNewFiles.push({ name: `${path.basename(objLocalDir)}/${destRel}`, size });
          importBytesNew += size;
          importStatus.filesDone++;
          recordTouchedObject();
          recordTouchedSession(target);
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
          folderFileRows.push({
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
          try { await fs.promises.unlink(tmpDestPath); } catch { /* not created, or already gone */ }
          importStatus.filesDone++;
          const message = err instanceof Error ? err.message : 'copy failed';
          insertImportLogSafe(rootPath, file.relPath, targetObjectId, target, 'error', message);
          log.warn({ file: file.name, objectId: targetObjectId, err: message }, '[folder-import] copy-error');
        }
      }

      recordLibraryFiles(folderFileRows);

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

    // RESTACKED: match each subfolder to a library object by name (same as
    // the live-sync path), creating the object via ensureRestackObject when
    // this is the first thing to ever land against that target, and land its
    // files as processed images instead of archived bytes.
    //
    // Candidates are collected for the WHOLE RESTACKED tree up front (exactly
    // like calibration frames), then only the files actually turned into
    // processed images are subtracted from what gets archived — rather than
    // assuming every file lives one level down inside a per-stack subfolder.
    // Real layout is unverified, and a loose file sitting directly in
    // RESTACKED/ must still be preserved as bytes, never silently dropped —
    // but a subfolder that resolves to a target id (however it resolves) no
    // longer needs a pre-existing object to match; see ensureRestackObject.
    let restackArchiveCandidates: ArchiveCandidate[] = [];
    if (restackedFolderName && !importCancelRequested) {
      importStatus.currentObject = 'RESTACKED (MegaStack)';
      await migrateRestackedToSharedRootOnce();
      const allRestackedCandidates = collectArchiveCandidates(resolvedRoot, [restackedFolderName]);
      const matchedRelPaths = new Set<string>();
      const restackedDir = path.join(resolvedRoot, restackedFolderName);
      let subs: fs.Dirent[] = [];
      try {
        subs = fs.readdirSync(restackedDir, { withFileTypes: true }).filter(e => e.isDirectory());
      } catch { /* unreadable — falls through to archiving the whole tree below */ }

      let restackMatched = 0;
      for (const sub of subs) {
        const subDir = path.join(restackedDir, sub.name);
        let shotsInfoTarget: string | null = null;
        try {
          shotsInfoTarget = targetFromShotsInfo(JSON.parse(fs.readFileSync(path.join(subDir, SHOTS_INFO_FILENAME), 'utf8')));
        } catch { /* no shotsInfo.json, or it's unreadable/invalid -- fall back to the folder name */ }
        const targetId = resolveRestackTargetId(sub.name, shotsInfoTarget);
        if (!targetId) continue; // nothing plausible to name an object after — stays in allRestackedCandidates, archived below
        // See the live-sync RESTACKED block above: shotsInfo.json has no date
        // field, so this comes from the subfolder's own trailing timestamp.
        const restackDate = extractDateFromSessionFolder(sub.name);

        let files: string[] = [];
        try {
          files = fs.readdirSync(subDir).filter(n => isRenderableProcessedName(n) || isStoredOnlyProcessedName(n));
        } catch { continue; }
        // Dwarf queues a RESTACKED subfolder before it has anything in it —
        // see the live-sync block's identical guard for why this must run
        // before ensureRestackObject, not after.
        if (!files.some(n => !isDwarfThumbnailPreviewName(n))) continue; // stays in allRestackedCandidates, archived below
        ensureRestackObject(targetId, index, commitProfile?.id ?? null);
        for (const f of files) {
          // Dwarf's redundant low-res preview of stacked.jpg -- never worth a
          // processed-image row. Leave it unmatched so it still lands in the
          // archive with everything else, bytes preserved either way.
          if (isDwarfThumbnailPreviewName(f)) continue;
          const relPath = `${restackedFolderName}/${sub.name}/${f}`;
          if (hasRestackedImage(targetId, f)) { matchedRelPaths.add(relPath); continue; } // already imported on a prior run
          const srcPath = path.join(subDir, f);
          const tmpPath = `${srcPath}.restack-import-${randomUUID()}`;
          try {
            fs.copyFileSync(srcPath, tmpPath);
            addProcessedImage(targetId, restackDate, tmpPath, f, mimeTypeForExtension(f), sub.name, '', null, 'dwarf-restack');
            restackMatched++;
            matchedRelPaths.add(relPath);
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err), file: f }, '[folder-import] RESTACKED file failed; skipping');
            try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
          }
        }
      }
      // relPath is remapped from whatever case the source folder actually used
      // (restackedFolderName) to the canonical RESTACKED_ROOT_DIR_NAME, so every
      // run lands in the same folder regardless of source casing — otherwise a
      // case-sensitive filesystem could split restacks across "RESTACKED" and
      // "Restacked". Done here, inside the block where restackedFolderName is
      // proven non-null, rather than at the copy site below where it isn't.
      // Only relPath (the destination) changes; absPath still points at the
      // source file copyToArchive reads from.
      restackArchiveCandidates = allRestackedCandidates
        .filter(c => !matchedRelPaths.has(c.relPath))
        .map(c => ({ ...c, relPath: RESTACKED_ROOT_DIR_NAME + c.relPath.slice(restackedFolderName.length) }));
      debugLog('import:dwarf', `RESTACKED: ${restackMatched} file(s) matched to an object, ${restackArchiveCandidates.length} file(s) archived (no matching object)`);
    }

    // Archive pass. Runs after the objects so a cancelled or failed run has
    // already saved the observations, which are the data the user came for.
    // Nothing here writes a DB row: these files are bytes in the library, not
    // objects, which is the whole point (see archiveFolders.ts).
    //
    // Two destinations, not one: calibration frames stay telescope-scoped
    // under _archive/<telescopeId>/ (two Dwarfs can have distinct CALI_FRAME
    // data), but restack leftovers go to the shared RESTACKED/ root at the
    // library root — see getRestackArchiveDir's doc. Their relPaths were
    // already remapped to the canonical RESTACKED_ROOT_DIR_NAME where they
    // were collected above.
    if (archiveCandidates.length > 0 && !importCancelRequested) {
      importStatus.currentObject = 'Archived folders';
      const archived = await copyToArchive(archiveCandidates, getArchiveDir(commitProfile?.id ?? null), {
        shouldCancel: () => importCancelRequested,
        onFile: () => { importStatus.filesDone++; },
        deleteSourceAfterCopy: stagedSource,
      });
      importStatus.archivedFiles = archived.copied + archived.alreadyPresent;
      importStatus.archivePath = getArchiveDir(commitProfile?.id ?? null);
      importBytesNew += archived.bytesCopied;
      log.info(
        { folders: excludedFolders, ...archived, dest: importStatus.archivePath },
        '[folder-import] archived non-observation folders',
      );
    }
    if (restackArchiveCandidates.length > 0 && !importCancelRequested) {
      importStatus.currentObject = 'Archived folders';
      const archived = await copyToArchive(restackArchiveCandidates, getLibraryDir(), {
        shouldCancel: () => importCancelRequested,
        onFile: () => { importStatus.filesDone++; },
        deleteSourceAfterCopy: stagedSource,
      });
      importStatus.restackArchivedFiles = archived.copied + archived.alreadyPresent;
      importStatus.restackArchivePath = getRestackArchiveDir();
      importBytesNew += archived.bytesCopied;
      log.info(
        { ...archived, dest: importStatus.restackArchivePath },
        '[folder-import] archived unmatched RESTACKED files',
      );
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
          // Same self-heal as the live-sync path above: fixed constants for a
          // reserved id, safe to re-apply on every import.
          if (objectId === getStartrailsObjectId()) {
            patchStartrailsObjectMeta(objectId);
          }
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
              stmts.addSessionTombstone.run(objectId, date, new Date().toISOString());
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
      try { await enrichObjectData(objectId); } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), objectId }, '[folder-import] catalog enrichment failed');
      }
      // Queued, not awaited — off the import-completion critical path (FC-3).
      try { enqueueSessionWeatherBackfill(objectId); } catch { /* best-effort */ }
    }

    // Pre-warm gallery thumbnails for newly-imported objects.
    if (importNewFiles.length > 0) {
      const newObjectIds = new Set(importNewFiles.map(f => resolveCanonicalId(normalizeObjectId(f.name.split('/')[0]))));
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
    writeImportHistory(importStatus, {
      newFiles: importNewFiles,
      bytesNew: importBytesNew,
      objectsTouched: importObjectsTouched,
      sessionsTouched: importSessionsTouched,
      source: 'folder',
    });
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
      try { fs.rmSync(path.resolve(rootPath), { recursive: true, force: true }); } catch (err) {
        // A leftover staged dir isn't fatal (the hourly sweep in
        // housekeeping.ts reclaims it eventually) but silently failing here
        // hides a growing disk-space leak if it happens repeatedly.
        log.warn({ err: err instanceof Error ? err.message : String(err), rootPath }, '[folder-import] staged upload cleanup failed');
      }
    }
  }
  } finally {
    releaseImportLock(myRunId);
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
