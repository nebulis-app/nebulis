/**
 * Bring one object's files into another object's folder after a merge.
 *
 * Reclassifying two different folders into one object moved the database rows and left the source files in their
 * original folder. Every list surface walks only the object's own folder, so those files vanished from the object page,
 * the gallery and the sessions even though the bytes and their `libraryFiles` rows were intact.
 *
 * This moves what can move and never overwrites or deletes: a file whose destination already exists stays where it is
 * and is counted in `leftBehind`, so the caller can say so. It takes the folders as arguments rather than looking them
 * up, because it is called from `objects.ts` and must not import it back.
 */
import fs from 'fs';
import path from 'path';
import { isRealFile } from '../telescopeFiles.js';
import { listObjectFiles, type LibraryLayout } from './libraryLayout.js';
import { getLibraryFileRow, deleteLibraryFileRow, moveLibraryFileRow, MANIFEST_NAME } from './libraryFiles.js';

export interface ConsolidateOptions {
  libraryDir: string;
  fromFolder: string;
  fromLayout: LibraryLayout;
  toFolder: string;
  toLayout: LibraryLayout;
  toObjectId: string;
}

export interface ConsolidateResult {
  moved: number;
  /** Files that stay in the old folder because the destination already holds a file at that path. */
  leftBehind: number;
}

/** Working files the read paths already hide; moving them would only create collisions. */
const isWorkingFile = (name: string): boolean => name.startsWith('sky_') || name.startsWith('gallery_');

function contained(root: string, dir: string): string | null {
  const resolved = path.resolve(root, dir);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

function moveFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

export function consolidateObjectFolder(opts: ConsolidateOptions): ConsolidateResult {
  const result: ConsolidateResult = { moved: 0, leftBehind: 0 };
  if (opts.fromFolder === opts.toFolder) return result;
  const fromDir = contained(opts.libraryDir, opts.fromFolder);
  const toDir = contained(opts.libraryDir, opts.toFolder);
  if (!fromDir || !toDir || fromDir === toDir || !fs.existsSync(fromDir)) return result;
  fs.mkdirSync(toDir, { recursive: true });

  // Same rule as moveObservation: adopt the source's shape when the target holds nothing, otherwise keep session
  // directories only when both sides are nested, so the target never ends up holding both shapes.
  const targetHasFiles = listObjectFiles(toDir, opts.toLayout).length > 0;
  const keepSessionDirs = targetHasFiles
    ? opts.toLayout === 'nested' && opts.fromLayout === 'nested'
    : opts.fromLayout === 'nested';

  for (const entry of listObjectFiles(fromDir, opts.fromLayout)) {
    if (!isRealFile(entry.fileName) || isWorkingFile(entry.fileName)) continue;
    const destRel = keepSessionDirs ? entry.relPath : entry.fileName;
    const dest = path.join(toDir, destRel);
    if (fs.existsSync(dest)) {
      result.leftBehind++;
      continue;
    }
    const fromRel = `${opts.fromFolder}/${entry.relPath}`;
    const destFullRel = `${opts.toFolder}/${destRel}`;
    try {
      moveFile(path.join(fromDir, entry.relPath), dest);
    } catch {
      result.leftBehind++;
      continue;
    }
    // A row at the destination for a file that is not there is stale; relPath is unique, so clear it first.
    if (getLibraryFileRow(destFullRel)) deleteLibraryFileRow(destFullRel);
    moveLibraryFileRow(fromRel, opts.toObjectId, opts.toFolder, destRel);
    result.moved++;
  }

  // Processed images live in `<folder>/processed/`, keyed by object and date in sessionProcessedImages, whose rows
  // moved with the merge; the files have to follow.
  const fromProcessed = path.join(fromDir, 'processed');
  if (fs.existsSync(fromProcessed)) {
    for (const name of fs.readdirSync(fromProcessed)) {
      const src = path.join(fromProcessed, name);
      const dest = path.join(toDir, 'processed', name);
      try {
        if (!fs.statSync(src).isFile()) continue;
        if (fs.existsSync(dest)) { result.leftBehind++; continue; }
        moveFile(src, dest);
        result.moved++;
      } catch {
        result.leftBehind++;
      }
    }
  }

  // Tidy only what is now empty. The old folder's manifest described files that no longer live there. Nothing else is
  // removed: a leftover `gallery_*` may be a picture the user chose.
  if (result.leftBehind === 0) {
    try { fs.rmSync(path.join(fromDir, MANIFEST_NAME), { force: true }); } catch { /* informational */ }
  }
  for (const dir of [path.join(fromDir, 'processed'), fromDir]) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* missing, or not empty: leave it */ }
  }
  return result;
}
