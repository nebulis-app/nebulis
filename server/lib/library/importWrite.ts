/**
 * The one "copy a file into the library" primitive.
 *
 * `runImport`, both sub-frame sync paths, and `remoteArchive.downloadToArchive`
 * each grew their own copy of: containment guard → already-present skip (plus a
 * partial-file heal) → `<dest>.tmp` → size check → `rename` → thumbnail enqueue,
 * with the streamed-vs-buffered transport branch duplicated in every one. Every
 * behavioural fix had to be hand-ported 2-3x, and several ports never happened
 * (CORE-PIPELINE-AUDIT High-2/High-3).
 *
 * This module owns the write. It deliberately does NOT touch `importStatus`,
 * `importNewFiles`, or the database — the caller owns all run-level bookkeeping
 * so the primitive stays reusable by the archive path too.
 */
import fs from 'fs';
import path from 'path';
import { smbGetFile, smbCopyFileTo, supportsStreamedCopy } from '../smb.js';
import type { TelescopeProfile } from '../telescopes.js';

const FITS_RE = /\.f(?:it|its|ts)$/i;

/**
 * Copy one file's bytes straight to `destPath`.
 *
 * A `local` USB mount is already a filesystem and FTP can stream its data
 * socket to disk, so `smbCopyFileTo` avoids buffering the whole file in RAM
 * (a real OOM risk for SeeStar video / master FITS and for a whole-object
 * Dwarf sub-frame sync). Everything else reads into a Buffer once. Writes
 * directly to `destPath`; the caller adds `.tmp`+rename when it needs atomicity.
 */
export async function copyTransportFile(
  source: string,
  destPath: string,
  profile: TelescopeProfile,
): Promise<number> {
  if (supportsStreamedCopy(profile)) {
    await smbCopyFileTo(source, destPath, profile);
    return (await fs.promises.stat(destPath)).size;
  }
  const data = await smbGetFile(source, undefined, profile);
  await fs.promises.writeFile(destPath, data);
  return data.length;
}

export interface LibraryWriteCandidate {
  /** Remote path (passed to the transport) for `sourceKind: 'transport'`, or an
   *  absolute local path for `sourceKind: 'localCopy'` (the folder wizard). */
  source: string;
  /** Object-relative destination, posix-style: `<session>/<name>` when nested,
   *  or just `<name>` for a flat object. */
  destRel: string;
  /** Size the discovery step reported, if known. Drives the size-mismatch guard
   *  (transport only) and the partial-file heal. */
  expectedSize?: number;
  sourceKind: 'transport' | 'localCopy';
}

export interface LibraryWriteCtx {
  /** The transport to pull from. Only read for `sourceKind: 'transport'`; the
   *  folder wizard's `localCopy` never needs one. */
  profile?: TelescopeProfile;
  /** Absolute object directory. Created if it does not exist yet. */
  objectDir: string;
  /** FITS files that actually land are pushed here for thumbnail generation.
   *  Omit to skip per-file thumbnailing (the folder wizard and archive path). */
  thumbnailQueue?: { push: (localPath: string) => void };
}

export type LibraryWriteOutcome =
  | { status: 'new'; bytes: number; localPath: string }
  | { status: 'exists'; bytes: number; localPath: string }
  | { status: 'error'; reason: string };

/**
 * Write one file into the library.
 *
 * - Refuses any destination that resolves outside `objectDir`.
 * - Skips a file already present at full size; re-copies one whose on-disk size
 *   doesn't match `expectedSize` (a prior run interrupted mid-write — the
 *   folder wizard's heal, now applied everywhere).
 * - Copies to `<dest>.tmp`, checks the size (transport sources only, matching
 *   the old telescope path), then renames.
 * - Enqueues a landed FITS file for thumbnailing when a queue was given.
 */
export async function writeFileIntoLibrary(
  candidate: LibraryWriteCandidate,
  ctx: LibraryWriteCtx,
): Promise<LibraryWriteOutcome> {
  const objRoot = path.resolve(ctx.objectDir);
  const localPath = path.resolve(objRoot, candidate.destRel);
  if (localPath !== objRoot && !localPath.startsWith(objRoot + path.sep)) {
    return { status: 'error', reason: `Refusing to write outside object directory: ${candidate.destRel}` };
  }

  const tmpPath = `${localPath}.tmp`;
  try {
    if (fs.existsSync(localPath)) {
      let onDiskBytes = 0;
      try { onDiskBytes = fs.statSync(localPath).size; } catch { /* treat as truncated */ }
      const truncated = candidate.expectedSize != null
        && candidate.expectedSize > 0
        && onDiskBytes !== candidate.expectedSize;
      if (!truncated) {
        return { status: 'exists', bytes: onDiskBytes || candidate.expectedSize || 0, localPath };
      }
      // else: fall through and overwrite the partial file
    }

    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

    let bytes: number;
    if (candidate.sourceKind === 'localCopy') {
      await fs.promises.copyFile(candidate.source, tmpPath);
      bytes = (await fs.promises.stat(tmpPath)).size;
    } else {
      if (!ctx.profile) throw new Error('writeFileIntoLibrary: a transport candidate needs ctx.profile');
      bytes = await copyTransportFile(candidate.source, tmpPath, ctx.profile);
      if (candidate.expectedSize != null && bytes !== candidate.expectedSize) {
        throw new Error(`Size mismatch: expected ${candidate.expectedSize}, got ${bytes} bytes`);
      }
    }

    await fs.promises.rename(tmpPath, localPath);

    if (ctx.thumbnailQueue && FITS_RE.test(localPath)) {
      ctx.thumbnailQueue.push(localPath);
    }

    return { status: 'new', bytes, localPath };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
