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
import path from 'path';
import { smbListDir, smbListDirGuarded, SmbWalkSession } from '../smb.js';
import type { TelescopeProfile } from '../telescopes.js';
import { resolveArchiveDestination, type ArchiveCopyResult } from './archiveFolders.js';
import { copyTransportFile } from './importWrite.js';
import { log } from '../logger.js';

/** Same bounds archiveFolders.ts's local walk uses, so a symlink loop or a
 *  pathological remote tree can't hang a live sync any more than it can hang
 *  the wizard's local walk.
 *
 *  `MAX_DEPTH` is the hard backstop, but a visited-path set (below) is the
 *  primary defence: the ASIAIR EMMC firmware can present a circular directory
 *  graph (`Autorun/Dark/Preview/…` cycling back to itself) that MAX_DEPTH
 *  alone would take minutes to exhaust, one 15-second smbclient call per level. */
const MAX_DEPTH = 3;   // lowered to 3 — calibration trees are rarely nested deeper than 1-2 levels (e.g. Darks/G100/60s). This strictly bounds the ASIAIR EMMC circular graph explosion.
const MAX_FILES = 200_000;

export interface RemoteArchiveCandidate {
  /** Full remote path, passable straight to smbGetFile/smbCopyFileTo. */
  remotePath: string;
  /** Path relative to the archive root, posix-style: `CALI_FRAME/dark_001.fits`. */
  relPath: string;
  size: number;
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
  opts: { shouldCancel?: () => boolean } = {},
): Promise<RemoteArchiveCandidate[]> {
  const out: RemoteArchiveCandidate[] = [];

  // One walk session per collectRemoteArchiveCandidates call — detects
  // circular directory graphs (ASIAIR EMMC firmware bug) via smbListDirGuarded.
  const session = SmbWalkSession.create(
    (cycleDir) => log.warn({ dir: cycleDir }, '[remote-archive] cycle detected — already visited this directory; skipping'),
  );

  const visit = async (dir: string, relPrefix: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    if (opts.shouldCancel?.()) return;

    let entries;
    try {
      entries = await smbListDirGuarded(dir, profile, session);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), dir }, '[remote-archive] directory listing failed; skipping');
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (opts.shouldCancel?.()) return;
      if (e.name.startsWith('.')) continue;
      const remotePath = path.posix.join(dir, e.name);
      const relPath = `${relPrefix}/${e.name}`;
      if (e.type === 'dir') {
        await visit(remotePath, relPath, depth + 1);
        continue;
      }
      out.push({ remotePath, relPath, size: e.size ?? 0 });
    }
  };

  for (const folder of folders) {
    if (opts.shouldCancel?.()) break;
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
  opts: { shouldCancel?: () => boolean; onFile?: (bytes: number) => void } = {},
): Promise<ArchiveCopyResult> {
  const result: ArchiveCopyResult = { copied: 0, alreadyPresent: 0, failed: 0, bytesCopied: 0 };
  if (candidates.length === 0) return result;

  for (const candidate of candidates) {
    if (opts.shouldCancel?.()) break;
    try {
      const { destPath, alreadyPresent } = await resolveArchiveDestination(archiveDir, candidate.relPath, candidate.size);
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
