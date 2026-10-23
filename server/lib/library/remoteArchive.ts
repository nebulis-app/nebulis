/**
 * Transport-based (FTP / local mount / SMB) equivalent of archiveFolders.ts's
 * local-fs-only `collectArchiveCandidates`/`copyToArchive`, for the live
 * telescope-sync path (server/lib/library/import.ts's `runImport`). Nothing
 * in archiveFolders.ts can be reused as-is there: it walks a rootPath with
 * plain `fs` calls, which only makes sense once a Dwarf's tree has already
 * been copied onto local disk (the manual folder-import wizard's case) — a
 * live sync only ever has the device reachable over its active transport.
 *
 * The destination-side dedup rule (already-present-at-same-size → skip, a
 * genuine clash → numeric suffix) is intentionally NOT reimplemented here:
 * it comes from `resolveArchiveDestination` in archiveFolders.ts, so a live
 * sync and a folder-import wizard run treat a repeat identically.
 */
import fs from 'fs';
import path from 'path';
import { smbListDir } from '../smb.js';
import type { TelescopeProfile } from '../telescopes.js';
import { resolveArchiveDestination, type ArchiveCopyResult } from './archiveFolders.js';
import { copyTransportFile } from './importWrite.js';
import { log } from '../logger.js';

/** Same bounds archiveFolders.ts's local walk uses, so a symlink loop or a
 *  pathological remote tree can't hang a live sync any more than it can hang
 *  the wizard's local walk. */
const MAX_DEPTH = 12;
const MAX_FILES = 200_000;

/** A walk that hits this many directory listings failing back-to-back gives
 *  up: the device has dropped off the network (a station-mode router tearing
 *  down an idle TCP session, say) and every further listing would just burn
 *  its own full smbclient timeout before failing the same way. Missing
 *  directories are not failures (smbListDir returns an empty listing for
 *  those), so a healthy device with an absent folder never trips this. */
const MAX_CONSECUTIVE_LIST_FAILURES = 3;

export interface RemoteArchiveWalkOptions {
  /** Polled before every listing and between entries, so a cancelled sync
   *  stops the walk promptly instead of finishing the sweep. */
  shouldCancel?: () => boolean;
  /** Override MAX_DEPTH. Depth 0 is the folder being swept, so this counts
   *  levels *below* it and never the path leading up to it. */
  maxDepth?: number;
  /** Refuse to descend into a directory whose path (relative to the swept
   *  folder's root, never the device path above it) repeats a segment name,
   *  e.g. `Autorun/Dark/Preview/Plan/Dark`. For trees known to be flat, where
   *  a repeat can only mean a phantom cycle — see ASIAIR_CALIBRATION_WALK.
   *  Off by default: an arbitrary user folder may legitimately repeat a name
   *  (`Photos/2024/Photos`), and skipping it would silently drop real data. */
  skipRepeatedSegments?: boolean;
}

function repeatsSegment(relPath: string): boolean {
  const segments = relPath.split('/').filter(Boolean);
  return new Set(segments).size < segments.length;
}

export interface RemoteArchiveCandidate {
  /** Full remote path, passable straight to smbGetFile/smbCopyFileTo. */
  remotePath: string;
  /** Path relative to the archive root, posix-style: `CALI_FRAME/dark_001.fits`. */
  relPath: string;
  size: number;
  /** Device-reported modification time (ISO), when the transport lists one. */
  mtime?: string;
}

/**
 * Recursively enumerate every file under `<basePath>/<folder>` for each of
 * `folders`, over whatever transport `profile` resolves to. Each top-level
 * folder is isolated in its own try/catch so one unreadable RESTACKED
 * subfolder can't drop CALI_FRAME from the same run.
 */
export async function collectRemoteArchiveCandidates(
  profile: TelescopeProfile,
  basePath: string,
  folders: readonly string[],
  opts: RemoteArchiveWalkOptions = {},
): Promise<RemoteArchiveCandidate[]> {
  const out: RemoteArchiveCandidate[] = [];
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  let consecutiveFailures = 0;
  const stopped = () => opts.shouldCancel?.() === true || consecutiveFailures >= MAX_CONSECUTIVE_LIST_FAILURES;

  const visit = async (dir: string, relPrefix: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > maxDepth || stopped()) return;
    if (depth > 0 && opts.skipRepeatedSegments && repeatsSegment(relPrefix)) {
      log.warn({ dir }, '[remote-archive] repeated directory name in path (phantom cycle); skipping');
      return;
    }
    let entries;
    try {
      entries = await smbListDir(dir, profile);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      log.warn({ err: err instanceof Error ? err.message : String(err), dir }, '[remote-archive] directory listing failed; skipping');
      if (consecutiveFailures >= MAX_CONSECUTIVE_LIST_FAILURES) {
        log.warn({ dir }, '[remote-archive] repeated listing failures; abandoning this sweep (device unreachable?)');
      }
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES || stopped()) return;
      if (e.name.startsWith('.')) continue;
      const remotePath = path.posix.join(dir, e.name);
      const relPath = `${relPrefix}/${e.name}`;
      if (e.type === 'dir') {
        await visit(remotePath, relPath, depth + 1);
        continue;
      }
      out.push({ remotePath, relPath, size: e.size ?? 0, ...(e.mtime ? { mtime: e.mtime } : {}) });
    }
  };

  for (const folder of folders) {
    if (stopped()) break;
    await visit(path.posix.join(basePath, folder), folder, 0);
  }
  return out;
}

/**
 * Download candidates straight into `archiveDir`, using the same
 * supportsStreamedCopy(profile) ? smbCopyFileTo : smbGetFile pattern the main
 * import loop uses for every other file. `shouldCancel` is polled between
 * files so a cancelled sync stops here too, keeping whatever already landed.
 */
export async function downloadToArchive(
  profile: TelescopeProfile,
  candidates: readonly RemoteArchiveCandidate[],
  archiveDir: string,
  opts: {
    shouldCancel?: () => boolean;
    onFile?: (bytes: number) => void;
    /** A file whose size or device mtime differs from the archived copy
     *  replaces it in place (the old copy is kept under `.replaced/`) instead
     *  of landing beside it as `name (1).ext`. For a device that regenerates
     *  files under the same names, like SeeStar's dark library. */
    replaceChanged?: boolean;
  } = {},
): Promise<ArchiveCopyResult & { replaced: number }> {
  const result: ArchiveCopyResult & { replaced: number } = { copied: 0, alreadyPresent: 0, failed: 0, bytesCopied: 0, replaced: 0 };
  if (candidates.length === 0) return result;

  // Only a 'local' transport's remotePath is a real filesystem path (see
  // smb.local.ts); resolve it against profile.localPath so
  // resolveArchiveDestination's isAlreadyInsideArchive guard can compare it
  // against archiveDir. FTP/SMB remotePaths live on the device itself and
  // can never overlap a local archiveDir, so the guard is a deliberate no-op
  // for those transports.
  const resolveSourceAbsPath = profile.connectionType === 'local' && profile.localPath
    ? (remotePath: string) => path.resolve(profile.localPath, remotePath)
    : undefined;

  const replacedStamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const candidate of candidates) {
    if (opts.shouldCancel?.()) break;
    try {
      if (opts.replaceChanged) {
        const outcome = await copyReplacingChanged(profile, candidate, archiveDir, replacedStamp);
        if (outcome === 'present') result.alreadyPresent++;
        else {
          result.copied++;
          if (outcome === 'replaced') result.replaced++;
          result.bytesCopied += candidate.size;
        }
        opts.onFile?.(candidate.size);
        continue;
      }
      const sourceAbsPath = resolveSourceAbsPath?.(candidate.remotePath);
      const { destPath, alreadyPresent } = await resolveArchiveDestination(archiveDir, candidate.relPath, candidate.size, sourceAbsPath);
      if (alreadyPresent) {
        result.alreadyPresent++;
        opts.onFile?.(candidate.size);
        continue;
      }
      await copyTransportFile(candidate.remotePath, destPath, profile);
      result.copied++;
      result.bytesCopied += candidate.size;
      opts.onFile?.(candidate.size);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), file: candidate.relPath }, '[remote-archive] file download failed; skipping');
      result.failed++;
      opts.onFile?.(candidate.size);
    }
  }
  return result;
}

/** Device clocks are coarse and FTP/SMB listings round differently, so two
 *  times within this window count as the same. */
const MTIME_TOLERANCE_MS = 2000;

/** Hidden, so the Calibrations page and every archive sweep skip it. */
const REPLACED_DIR_NAME = '.replaced';

/**
 * Copy one candidate into `archiveDir`, replacing an archived copy that no
 * longer matches the device. "Matches" is same size and, when the device
 * reported one, a modification time within MTIME_TOLERANCE_MS: the archived
 * file is stamped with the device's mtime after copying, so equality means
 * "unchanged since I copied it" and survives a device clock that is wrong.
 *
 * The new bytes land in `<dest>.part` and are renamed over the old file, and
 * the old file is moved to `.replaced/<stamp>/<relPath>` first, so a dropped
 * connection never leaves the archive without a usable copy.
 */
async function copyReplacingChanged(
  profile: TelescopeProfile,
  candidate: RemoteArchiveCandidate,
  archiveDir: string,
  stamp: string,
): Promise<'present' | 'copied' | 'replaced'> {
  const segments = candidate.relPath.split('/');
  const destPath = path.join(archiveDir, ...segments);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const remoteMs = candidate.mtime ? Date.parse(candidate.mtime) : Number.NaN;
  const existing = await fs.promises.stat(destPath).then(s => (s.isFile() ? s : null), () => null);
  if (existing && existing.size === candidate.size
      && (Number.isNaN(remoteMs) || Math.abs(existing.mtimeMs - remoteMs) <= MTIME_TOLERANCE_MS)) {
    return 'present';
  }

  const partPath = `${destPath}.part`;
  try {
    await copyTransportFile(candidate.remotePath, partPath, profile);
    const onDisk = (await fs.promises.stat(partPath)).size;
    if (candidate.size > 0 && onDisk !== candidate.size) {
      throw new Error(`copied ${onDisk} of ${candidate.size} bytes`);
    }
    if (!Number.isNaN(remoteMs)) {
      const when = new Date(remoteMs);
      await fs.promises.utimes(partPath, when, when);
    }
    if (existing) {
      const keptPath = path.join(archiveDir, REPLACED_DIR_NAME, stamp, ...segments);
      await fs.promises.mkdir(path.dirname(keptPath), { recursive: true });
      await fs.promises.rename(destPath, keptPath);
    }
    await fs.promises.rename(partPath, destPath);
  } catch (err) {
    await fs.promises.rm(partPath, { force: true });
    throw err;
  }
  return existing ? 'replaced' : 'copied';
}
