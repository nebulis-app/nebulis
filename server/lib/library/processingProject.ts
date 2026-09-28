/**
 * @fileoverview Processing Project management for deep-sky astronomical objects.
 *
 * Provides inspection, file management, traversal security, and synchronization
 * for working project files stored under `<objectFolder>/processing_project/`
 * (e.g. PixInsight process icons `.xpsm`, project archives `.pxi`/`.xisf`,
 * Siril scripts/sessions, intermediate master frames, and workflow logs).
 */

import fs from 'fs';
import path from 'path';
import { getFolderName, resolveContainedObjectDir } from './objects.js';
import { isErrnoException } from '../errors.js';

/**
 * File metadata for a single item located within a processing project directory.
 */
export interface ProcessingProjectFileInfo {
  /** Base filename with extension (e.g. "M42_workflow.xpsm"). */
  name: string;
  /** Relative path inside the processing_project folder (e.g. "icons/M42_workflow.xpsm"). */
  relativePath: string;
  /** File size in bytes. */
  size: number;
  /** ISO-8601 modification timestamp. */
  mtime: string;
  /** Lowercase file extension including leading dot (e.g. ".xpsm", ".xisf"). */
  extension: string;
}

/**
 * Summary descriptor of an object's processing project folder contents.
 */
export interface ProcessingProjectSummary {
  /** Whether the `processing_project` directory exists on disk for this object. */
  exists: boolean;
  /** Unique catalog or internal identifier for the astronomical object. */
  objectId: string;
  /** Disk directory name of the object (e.g. "M42_Orion_Nebula"). */
  folderName: string;
  /** Relative path from library root to the processing project directory. */
  relativePath: string;
  /** Total count of non-hidden files in the processing project tree. */
  fileCount: number;
  /** Total size in bytes of all contained project files. */
  totalSize: number;
  /** Flat list of all discovered project files. */
  files: ProcessingProjectFileInfo[];
}

/**
 * Resolves a path strictly within `<LIBRARY_DIR>/<objectFolder>/processing_project/`.
 *
 * Enforces boundary containment to prevent directory traversal vulnerabilities.
 * Returns `null` if the path attempts traversal (`..`), escapes the boundary,
 * or if the object directory cannot be resolved.
 *
 * @param objectId - Catalog or internal identifier of the target object.
 * @param extra - Optional additional relative path components within `processing_project/`.
 * @returns Fully qualified absolute filesystem path, or `null` if invalid or escaping boundary.
 */
export function resolveProcessingProjectDir(objectId: string, ...extra: string[]): string | null {
  const base = resolveContainedObjectDir(objectId, 'processing_project');
  if (!base) return null;
  if (extra.length === 0) return base;
  const resolved = path.resolve(base, ...extra);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * Inspects `<objectFolder>/processing_project/` and returns metadata and file lists.
 *
 * Recursively scans the directory tree, ignoring hidden/system files (starting with `.`),
 * computing total size and sorting files alphabetically.
 *
 * @param objectId - Catalog or internal identifier of the target object.
 * @returns Processing project summary containing file counts, sizes, and file list.
 */
export function getProcessingProjectSummary(objectId: string): ProcessingProjectSummary {
  const folderName = getFolderName(objectId);
  const relBase = `${folderName}/processing_project`;
  const dir = resolveProcessingProjectDir(objectId);

  if (!dir || !fs.existsSync(dir)) {
    return {
      exists: false,
      objectId,
      folderName,
      relativePath: relBase,
      fileCount: 0,
      totalSize: 0,
      files: [],
    };
  }

  const files: ProcessingProjectFileInfo[] = [];
  let totalSize = 0;

  function walk(currentDir: string, currentRel: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort entries alphabetically
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // ignore hidden/system files
      const entryPath = path.join(currentDir, entry.name);
      const entryRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(entryPath, entryRel);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(entryPath);
          totalSize += st.size;
          files.push({
            name: entry.name,
            relativePath: entryRel,
            size: st.size,
            mtime: st.mtime.toISOString(),
            extension: path.extname(entry.name).toLowerCase(),
          });
        } catch {
          // ignore unreadable file
        }
      }
    }
  }

  walk(dir, '');

  return {
    exists: true,
    objectId,
    folderName,
    relativePath: relBase,
    fileCount: files.length,
    totalSize,
    files,
  };
}

/**
 * Saves an uploaded or staged file into `<objectFolder>/processing_project/<subPath>`.
 *
 * Normalizes destination paths and strictly prohibits traversal or absolute paths.
 * Creates intermediate directories as needed. Uses atomic filesystem rename where
 * possible, falling back to copy+unlink across filesystem boundaries (`EXDEV`).
 *
 * @param objectId - Catalog or internal identifier of the target object.
 * @param subPath - Relative destination path within `processing_project/` (e.g. "workflow.xpsm").
 * @param sourceFilePath - Absolute path to the source file to move into the project directory.
 * @returns Object with absolute saved path, library-relative path, and file size in bytes.
 * @throws {Error} If destination path is invalid, traverses outside boundary, or fails write.
 */
export function saveProcessingProjectFile(
  objectId: string,
  subPath: string,
  sourceFilePath: string,
): { savedPath: string; relativePath: string; size: number } {
  const normalized = path.normalize(subPath).replace(/\\/g, '/');
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('/../') ||
    normalized.includes('\0')
  ) {
    throw new Error('Invalid destination subpath for processing project file');
  }

  const destDir = resolveProcessingProjectDir(objectId);
  if (!destDir) {
    throw new Error(`Cannot resolve processing_project directory for object ${objectId}`);
  }

  const destPath = resolveProcessingProjectDir(objectId, normalized);
  if (!destPath) {
    throw new Error('Invalid file destination path (directory traversal attempt)');
  }

  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  try {
    fs.renameSync(sourceFilePath, destPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EXDEV') {
      fs.copyFileSync(sourceFilePath, destPath);
      fs.unlinkSync(sourceFilePath);
    } else {
      throw err;
    }
  }

  const st = fs.statSync(destPath);
  const folderName = getFolderName(objectId);
  return {
    savedPath: destPath,
    relativePath: `${folderName}/processing_project/${normalized}`,
    size: st.size,
  };
}
