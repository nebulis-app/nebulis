/**
 * Copying the library to the archive disk.
 *
 * **This step deletes nothing.** The only file it ever removes is a `.part` file
 * it created itself in the same run, and it does that to clean up after a failed
 * or interrupted copy. Nothing in the library is modified, and nothing already on
 * the destination disk is removed. The destructive operations are separate,
 * later modules (`archiveRetention`, `archiveLocalRemoval`) and each has its own
 * refusal tests.
 *
 * The shape of a copy is the part worth reading carefully:
 *
 *   1. The source is digested, so there is a known-good value to check against.
 *   2. The bytes are written to `<destination>.part`, never to the final name.
 *   3. The part file is digested and compared to the source.
 *   4. Only then is it renamed into place.
 *
 * A crash or a full disk therefore cannot leave a truncated file wearing the final
 * name. That matters beyond tidiness: a later step offers to delete local
 * subframes once their archived copy is "verified", and a file that merely exists
 * is not verified. Keeping the incomplete bytes under a name that is obviously
 * incomplete is what makes that check meaningful.
 *
 * The copy is asynchronous and yields between files, so a multi-gigabyte run does
 * not block the API. That is also what makes an overlapping run possible, which is
 * why the in-progress guard is not merely defensive.
 */

import fsp from 'fs/promises';
import path from 'path';

import { sha256File } from './archiveDigest.js';
import { getArchiveConfig, type ArchiveConfig } from './archiveConfig.js';
import { resolveContainedArchivePath } from './archivePath.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { createDiskGuard, DiskGoneError, DISK_LOST_MESSAGE, type DiskGuard } from './archiveDiskGuard.js';
import { selectArchiveFiles, type ArchiveCandidate } from './archiveSelect.js';
import type { ArchiveManifest, ArchiveManifestFile } from './archiveManifest.js';
import { mergeArchiveRun, readArchiveManifestResult, writeArchiveManifest, EMPTY_ARCHIVE_MANIFEST } from './archiveManifest.js';
import { availableBytes, bytesStillNeeded, hasRoomFor } from './archiveSpace.js';

/** Suffix for an in-flight copy. `isRealFile` rejects nothing here, but the
 *  selector only ever reads the library, and this name is only ever written to
 *  the archive, so a leftover file is visibly not a real capture. */
const PART_SUFFIX = '.part';

/** How often the record is flushed during a run: whichever comes first. An
 *  interrupted run therefore leaves at most this much copied but unrecorded, and
 *  unrecorded files can never be pruned by retention, which is safe but untidy. */
const MANIFEST_FLUSH_FILES = 500;
const MANIFEST_FLUSH_MS = 5 * 60_000;

export type ArchiveRunPhase = 'idle' | 'scanning' | 'copying' | 'done' | 'failed';

export interface ArchiveRunProgress {
  running: boolean;
  phase: ArchiveRunPhase;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  copied: number;
  skipped: number;
  startedAt: number | null;
  finishedAt: number | null;
  warnings: string[];
}

export type ArchiveRunRefusal = 'already-running' | 'no-destination' | 'destination-unusable' | 'insufficient-space';

export interface ArchiveRunResult {
  ran: boolean;
  reason?: ArchiveRunRefusal;
  copied: number;
  skipped: number;
  /** Left behind by `copyMinAgeEnabled`: selected, but not yet old enough. See
   *  `ArchiveSelection.tooYoungSkipped`. */
  tooYoungSkipped: number;
  /** Files of linked folders, left out on purpose. See `ArchiveSelection.linkedSkipped`. */
  linkedSkipped: number;
  /** True when the run was stopped by its `AbortSignal` before the end of the
   *  selection. What had landed by then is recorded; nothing else is written. */
  cancelled: boolean;
  /** True when the archive disk went away mid-run and the run stopped for that reason. Files copied before
   *  that are safe on the disk; nothing further was written, and the caller must not delete or prune on the
   *  strength of a run that ended this way. */
  diskLost?: boolean;
  bytesCopied: number;
  failures: Array<{ archiveRelPath: string; error: string }>;
  warnings: string[];
}

export interface CopyOutcome {
  ok: boolean;
  /** False when the destination already held a verified copy. */
  copied: boolean;
  error?: string;
  /** The verified digest of the source, for the record. Set on every success. */
  sha256?: string;
  /** The copy was abandoned because the run was cancelled; no `.part` is left. */
  cancelled?: boolean;
  /** The archive disk was no longer the one the run started on. Whatever this call had written since the
   *  last good check has been taken away again. */
  diskGone?: boolean;
}

const IDLE_PROGRESS: ArchiveRunProgress = {
  running: false,
  phase: 'idle',
  filesTotal: 0,
  filesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  copied: 0,
  skipped: 0,
  startedAt: null,
  finishedAt: null,
  warnings: [],
};

let progress: ArchiveRunProgress = { ...IDLE_PROGRESS };

/** A copy of the current progress. Read by the status route. */
export function getArchiveRunProgress(): ArchiveRunProgress {
  return { ...progress, warnings: [...progress.warnings] };
}

export function isArchiveRunning(): boolean {
  return progress.running;
}

/** Remove our own in-flight file. Never touches a final destination path. */
async function removePartFile(partPath: string): Promise<void> {
  try {
    await fsp.unlink(partPath);
  } catch {
    // Already gone, or the disk went away. Either way there is nothing to do,
    // and the caller is already reporting a failure.
  }
}

/** How old a `.part` must be before a later run treats it as abandoned. A day is far
 *  longer than any single file takes to copy, so a live copy is never mistaken for one. */
export const STALE_PART_AGE_MS = 24 * 60 * 60_000;

/**
 * Delete the abandoned `.part` files of copies that were interrupted and never
 * retried (a pulled disk, a killed process).
 *
 * Only a file named `<a path this run or restore is about to write>.part` counts, so
 * a user file that merely ends in `.part` is left alone unless it sits next to a
 * target of ours under exactly that name. Directories are listed once each rather
 * than every target being stat'ed, because on a network share a round trip per file
 * over a large library costs far more than the listing does.
 */
export async function sweepStaleParts(targetPaths: string[], nowMs: number = Date.now()): Promise<number> {
  const wantedByDir = new Map<string, Set<string>>();
  for (const target of targetPaths) {
    const dir = path.dirname(target);
    const names = wantedByDir.get(dir) ?? new Set<string>();
    names.add(path.basename(target) + PART_SUFFIX);
    wantedByDir.set(dir, names);
  }

  let removed = 0;
  for (const [dir, wanted] of wantedByDir) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue; // Not created yet, or unreadable: nothing of ours to clean.
    }
    for (const name of entries) {
      if (!wanted.has(name)) continue;
      const partPath = path.join(dir, name);
      try {
        const stat = await fsp.lstat(partPath);
        if (stat.isFile() && nowMs - stat.mtimeMs >= STALE_PART_AGE_MS) {
          await fsp.unlink(partPath);
          removed++;
        }
      } catch {
        // Gone already, or the disk went away. Either way, not worth failing a run over.
      }
    }
  }
  return removed;
}

/**
 * Whether `destPath` is a verified copy of `sourcePath`: a regular file, the same
 * size, and the same digest.
 *
 * Exported and used by both callers that need this answer, because the one that
 * deletes a local file must not have its own weaker idea of "verified". That is
 * precisely the mistake behind the Dwarf RESTACKED migration, which inferred
 * "already present" from a path relationship and then removed the source.
 *
 * `sourceDigest` may be passed when the caller already computed it.
 */
export async function verifyArchivedCopy(
  sourcePath: string,
  destPath: string,
  sourceDigest?: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const [sourceStat, destStat] = await Promise.all([fsp.stat(sourcePath), fsp.stat(destPath)]);
    if (!sourceStat.isFile() || !destStat.isFile()) return { ok: false, reason: 'not a regular file' };
    if (sourceStat.size !== destStat.size) {
      return { ok: false, reason: `size differs (${destStat.size} of ${sourceStat.size} bytes)` };
    }
    const source = sourceDigest ?? (await sha256File(sourcePath));
    if ((await sha256File(destPath)) !== source) return { ok: false, reason: 'contents differ' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'could not be read' };
  }
}

/**
 * Copy one file, verifying it before it takes its final name.
 *
 * `expectedBytes` comes from selection. Checking it first means a source that
 * changed between selection and copy is refused rather than silently archived at
 * a size nothing agreed on.
 */
/** What an earlier run recorded about a file it archived. */
export interface KnownArchivedFile {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

export async function copyFileVerified(
  sourcePath: string,
  destPath: string,
  expectedBytes: number,
  signal?: AbortSignal,
  known?: KnownArchivedFile,
  guard?: DiskGuard,
): Promise<CopyOutcome> {
  const partPath = `${destPath}${PART_SUFFIX}`;
  /** Folders this call created, and whether the file took its final name, so a disk that vanishes
   *  mid-copy can be unwound to exactly what this call added. */
  let createdDirs: string[] = [];
  let renamed = false;

  /** Take away what this call wrote. Only paths this call created: its own final file, its own `.part`, and
   *  the empty folders it made. Called once the disk is known to be gone, when those paths resolve to an
   *  ordinary folder on the app's own disk. */
  const undoWrite = async (): Promise<void> => {
    await removePartFile(partPath);
    if (renamed) {
      try {
        await fsp.unlink(destPath);
      } catch {
        // Already gone.
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        await fsp.rmdir(dir); // Only succeeds when empty, which is what "created by this call" means.
      } catch {
        // Not empty, or gone.
      }
    }
  };

  try {
    const sourceStat = await fsp.stat(sourcePath);
    if (!sourceStat.isFile()) return { ok: false, copied: false, error: 'source is not a file' };
    if (sourceStat.size !== expectedBytes) {
      return {
        ok: false,
        copied: false,
        error: `source size changed since selection (${sourceStat.size} != ${expectedBytes})`,
      };
    }

    // Unchanged since an earlier run verified it: same size and mtime at the source,
    // and a file of the recorded size at the destination. Neither side is hashed.
    // This is only the copy engine's "nothing to do" shortcut. Anything that deletes
    // (`removeVerifiedLocalSubframes`, retention) still calls `verifyArchivedCopy`,
    // which hashes both sides, so this cannot weaken what "verified" means there.
    if (known !== undefined && sourceStat.size === known.bytes && sourceStat.mtimeMs === known.mtimeMs) {
      try {
        const destStat = await fsp.stat(destPath);
        if (destStat.isFile() && destStat.size === known.bytes) {
          return { ok: true, copied: false, sha256: known.sha256 };
        }
      } catch {
        // Missing at the destination: fall through to a real copy.
      }
    }

    const sourceDigest = await sha256File(sourcePath);

    // Already archived: the same verification the local-removal step relies on,
    // so "skip because it is there" and "delete locally because it is there" can
    // never disagree about what "there" means.
    if ((await verifyArchivedCopy(sourcePath, destPath, sourceDigest)).ok) {
      return { ok: true, copied: false, sha256: sourceDigest };
    }

    if (guard) {
      // Before anything is written: is this still the disk? And create only folders below its root, never the
      // root itself, so a vanished disk cannot be quietly rebuilt on the app's own disk.
      await guard.assertPresent();
      createdDirs = await guard.mkdirBelowRoot(path.dirname(destPath));
    } else {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
    }
    await fsp.copyFile(sourcePath, partPath);

    // A cancel that arrived during a large copy is honoured here, before the file
    // takes its final name, so an abandoned copy is never left wearing one.
    if (signal?.aborted) {
      await removePartFile(partPath);
      return { ok: false, copied: false, cancelled: true };
    }

    const partStat = await fsp.stat(partPath);
    if (partStat.size !== sourceStat.size) {
      await removePartFile(partPath);
      return { ok: false, copied: false, error: `short write (${partStat.size} of ${sourceStat.size} bytes)` };
    }
    if ((await sha256File(partPath)) !== sourceDigest) {
      await removePartFile(partPath);
      return { ok: false, copied: false, error: 'digest mismatch after copy' };
    }

    await fsp.rename(partPath, destPath);
    renamed = true;
    // And again afterwards: a disk pulled during the copy leaves this file on an ordinary folder. If the disk
    // is no longer ours, the catch below unwinds it and the file is not recorded.
    if (guard) await guard.assertPresent();
    return { ok: true, copied: true, sha256: sourceDigest };
  } catch (err) {
    // A failure with the disk gone is the disk's fault, whatever the error said (ENOENT, EIO, a stale mount).
    // Probing costs one stat and a small read, and only on the failure path.
    let gone = err instanceof DiskGoneError;
    if (!gone && guard) {
      try {
        await guard.assertPresent();
      } catch {
        gone = true;
      }
    }
    if (gone) {
      await undoWrite();
      return { ok: false, copied: false, diskGone: true, error: DISK_LOST_MESSAGE };
    }
    await removePartFile(partPath);
    return { ok: false, copied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function refusal(reason: ArchiveRunRefusal): ArchiveRunResult {
  return {
    ran: false,
    reason,
    copied: 0,
    skipped: 0,
    tooYoungSkipped: 0,
    linkedSkipped: 0,
    cancelled: false,
    bytesCopied: 0,
    failures: [],
    warnings: [],
  };
}

/**
 * Copy everything this configuration selects to the archive disk.
 *
 * Refuses before writing anything unless the destination resolves to a usable,
 * contained root **and** its marker identifies it as ours. That check is what
 * stops a run from writing into a disk the user has since swapped, which would
 * otherwise mix two archives together and make the marker meaningless.
 */
export async function runArchive(
  config: ArchiveConfig = getArchiveConfig(),
  options: { signal?: AbortSignal } = {},
): Promise<ArchiveRunResult> {
  const { signal } = options;
  if (progress.running) return refusal('already-running');

  // The slot is claimed *before* the first await, not after it. Readiness is
  // asynchronous now, so a second call arriving in the same tick would otherwise
  // find the slot free and race this one to the copy. Every path that returns before
  // the try block below releases it again, so a refusal is not left looking like a
  // run in progress.
  progress = { ...IDLE_PROGRESS, running: true, phase: 'scanning', startedAt: Date.now() };

  // Connect first where that applies, then prove the marker: one call, so no path
  // can answer "is it reachable" without also answering "is it ours".
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) {
    progress = { ...IDLE_PROGRESS };
    return refusal(readiness.kind === 'unconfigured' ? 'no-destination' : 'destination-unusable');
  }
  const root = readiness.root;

  // From here on the disk is re-proven around every write (see archiveDiskGuard.ts): the readiness check
  // above answers "is it ours" once, and a run lasts long enough for the disk to go away.
  let guard: DiskGuard;
  try {
    guard = await createDiskGuard(root, config.archiveId);
  } catch {
    progress = { ...IDLE_PROGRESS };
    return refusal('destination-unusable');
  }

  // Read the record before writing anything. A record that exists but cannot be
  // read must never be replaced by a fresh one: that erases the only account of what
  // is on the disk. Nothing is copied either, because files that landed without a
  // record could never be tracked once the record is repaired.
  const manifestRead = readArchiveManifestResult(root, config.archiveId);
  if (manifestRead.status === 'unreadable') {
    progress = { ...IDLE_PROGRESS, phase: 'failed', finishedAt: Date.now() };
    return {
      ran: true,
      copied: 0,
      skipped: 0,
      tooYoungSkipped: 0,
      linkedSkipped: 0,
      cancelled: false,
      bytesCopied: 0,
      failures: [
        {
          archiveRelPath: '(manifest)',
          error: `the archive record on this disk could not be read (${manifestRead.reason}), so nothing was copied and the record was left as it is`,
        },
      ],
      warnings: [],
    };
  }
  // Stamped with this archive's id, so a disk later adopted by another install can
  // tell whose history the record holds.
  let record: ArchiveManifest = { ...(manifestRead.status === 'ok' ? manifestRead.manifest : EMPTY_ARCHIVE_MANIFEST), archiveId: config.archiveId };

  try {
    const selection = selectArchiveFiles(config);
    progress.filesTotal = selection.candidates.length;
    progress.bytesTotal = selection.bytesTotal;
    progress.warnings = [...selection.warnings];
    progress.phase = 'copying';

    let copied = 0;
    let skipped = 0;
    let bytesCopied = 0;
    const failures: ArchiveRunResult['failures'] = [];
    /** Files that landed and are not yet in the record. Only files that actually
     *  landed are ever added, so the record can never claim a file the disk lacks. */
    let unrecorded: ArchiveCandidate[] = [];
    let lastFlushAt = Date.now();
    let manifestFailed = false;
    let diskLost = false;

    /** The disk is gone: remember it once, and say so once. */
    const markDiskLost = (): void => {
      if (diskLost) return;
      diskLost = true;
      failures.push({ archiveRelPath: '(disk)', error: DISK_LOST_MESSAGE });
    };

    const flushRecord = async (): Promise<void> => {
      if (unrecorded.length === 0 || manifestFailed || diskLost) return;
      // The record is a file in the archive root. Writing it after the disk is gone would put a manifest in the
      // empty mount point, so the disk is proven first. Files that landed before the loss stay unrecorded, which
      // is the safe direction: the next run verifies them and records them then.
      try {
        await guard.assertPresent();
      } catch {
        markDiskLost();
        return;
      }
      try {
        record = mergeArchiveRun(record, unrecorded, new Date().toISOString());
        writeArchiveManifest(root, record);
        unrecorded = [];
        lastFlushAt = Date.now();
      } catch (err) {
        // One failure is reported once. Retrying every file would only repeat it,
        // and the final flush below would report a second, identical failure.
        manifestFailed = true;
        failures.push({
          archiveRelPath: '(manifest)',
          error: err instanceof Error ? err.message : 'could not write the archive manifest',
        });
      }
    };

    // Every destination path is resolved once, contained, and reused for both the
    // preflight and the copy. Resolving twice would let the two disagree if the disk
    // changed between them.
    const planned = selection.candidates.map(candidate => ({
      candidate,
      destination: resolveContainedArchivePath(root, ...candidate.archiveRelPath.split('/')),
    }));

    // Clear abandoned `.part` files from earlier interrupted runs, so they neither
    // waste space nor sit beside the real files looking like captures.
    await sweepStaleParts(planned.flatMap(p => (p.destination === null ? [] : [p.destination])));

    // Free-space preflight, against what still needs writing rather than the size of
    // the whole selection: a re-run over a complete archive copies nothing and must
    // not be blocked by a disk that is nearly full.
    const needed = await bytesStillNeeded(
      planned.flatMap(p => (p.destination === null ? [] : [{ bytes: p.candidate.bytes, destination: p.destination }])),
    );
    const available = await availableBytes(root);
    if (!hasRoomFor(needed, available)) {
      progress.phase = 'failed';
      const mb = (n: number): number => Math.round(n / 1024 ** 2);
      return {
        ran: false,
        reason: 'insufficient-space',
        copied: 0,
        skipped: 0,
        tooYoungSkipped: selection.tooYoungSkipped,
        linkedSkipped: selection.linkedSkipped,
        cancelled: false,
        bytesCopied: 0,
        failures: [
          {
            archiveRelPath: '(space)',
            error: `this run needs about ${mb(needed)} MB and the disk has ${mb(available ?? 0)} MB free`,
          },
        ],
        warnings: selection.warnings,
      };
    }

    // What the record already knows, so an unchanged library is not re-hashed. Only for
    // the same object: a folder reused by a different one proves nothing about its files.
    const filesByFolder = new Map<string, Map<string, ArchiveManifestFile>>();
    const knownFor = (candidate: ArchiveCandidate): KnownArchivedFile | undefined => {
      const entry = record.objects[candidate.folderName];
      if (entry === undefined || entry.objectId !== candidate.objectId) return undefined;
      let index = filesByFolder.get(candidate.folderName);
      if (index === undefined) {
        index = new Map(entry.files.map(f => [f.relPath, f]));
        filesByFolder.set(candidate.folderName, index);
      }
      const file = index.get(candidate.relPath);
      if (file?.sha256 === undefined || file.bytes === undefined || file.mtimeMs === undefined) return undefined;
      return { bytes: file.bytes, mtimeMs: file.mtimeMs, sha256: file.sha256 };
    };

    let cancelled = false;
    for (const { candidate, destination } of planned) {
      // Checked between files, and again inside the copy, so a cancel takes effect
      // at the next file boundary at the latest.
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      if (destination === null) {
        failures.push({
          archiveRelPath: candidate.archiveRelPath,
          error: 'destination path is not contained in the archive root',
        });
      } else {
        const outcome = await copyFileVerified(candidate.sourcePath, destination, candidate.bytes, signal, knownFor(candidate), guard);
        if (outcome.cancelled) {
          cancelled = true;
          break;
        }
        if (outcome.diskGone) {
          // Nothing further is attempted: every remaining file would fail the same way, or worse, land somewhere
          // that is not the disk. What this file wrote has already been taken away.
          markDiskLost();
          break;
        }
        if (outcome.ok) {
          candidate.sha256 = outcome.sha256;
          unrecorded.push(candidate);
          if (outcome.copied) {
            copied++;
            bytesCopied += candidate.bytes;
          } else {
            skipped++;
          }
        } else {
          failures.push({ archiveRelPath: candidate.archiveRelPath, error: outcome.error ?? 'copy failed' });
        }
      }

      progress.filesDone++;
      progress.bytesDone += candidate.bytes;
      progress.copied = copied;
      progress.skipped = skipped;

      if (unrecorded.length >= MANIFEST_FLUSH_FILES || Date.now() - lastFlushAt >= MANIFEST_FLUSH_MS) await flushRecord();
      if (diskLost) break;
    }

    // Record what landed, before reporting. Retention deletes only what this
    // record names, so a run that copied files but left no record is a run whose
    // files can never be pruned — safe, but not complete, so it is reported.
    await flushRecord();

    // A run with failures is not 'done': the UI must not report a clean archive
    // when files are missing from it.
    progress.phase = failures.length > 0 ? 'failed' : 'done';
    return {
      ran: true,
      copied,
      skipped,
      tooYoungSkipped: selection.tooYoungSkipped,
      linkedSkipped: selection.linkedSkipped,
      cancelled,
      ...(diskLost ? { diskLost: true } : {}),
      bytesCopied,
      failures,
      warnings: selection.warnings,
    };
  } catch (err) {
    progress.phase = 'failed';
    progress.warnings.push(err instanceof Error ? err.message : String(err));
    return {
      ran: true,
      copied: progress.copied,
      skipped: progress.skipped,
      tooYoungSkipped: 0,
      linkedSkipped: 0,
      cancelled: false,
      bytesCopied: 0,
      failures: [{ archiveRelPath: '(run)', error: err instanceof Error ? err.message : String(err) }],
      warnings: progress.warnings,
    };
  } finally {
    progress.running = false;
    progress.finishedAt = Date.now();
  }
}
