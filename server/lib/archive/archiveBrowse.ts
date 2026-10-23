/**
 * What is on the archive disk.
 *
 * Read-only, and reads only: it stats files to report sizes and to say whether each
 * one still exists in the library, which is what makes a file "restorable" rather
 * than "already there". It creates nothing and removes nothing.
 *
 * It deliberately lists objects the local library no longer has, marking them with
 * a null `objectId`. The archive is the record of what the user captured, and
 * hiding an object because the library has moved on would be the opposite of what
 * a backup browser is for.
 */

import fs from 'fs';

import { getLibraryObjectNames, resolveContainedObjectDir } from '../library/objects.js';
import { isRegularFile as isFile, localPathFor, rootFolderPathFor } from './archiveLocalCopy.js';
import { resolveContainedArchivePath } from './archivePath.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { readArchiveManifest } from './archiveManifest.js';
import type { ArchiveConfig } from './archiveConfig.js';

export interface ArchivedObjectSummary {
  folderName: string;
  /** Null when the local library no longer has this object. */
  objectId: string | null;
  firstArchivedAt: string;
  lastArchivedAt: string;
  filesTotal: number;
  subframes: number;
  /** Sum of the sizes of the archived files that are actually on the disk. */
  bytes: number;
  /** Files present in the archive but not locally: the ones restore can bring back. */
  missingLocally: number;
}

export interface ArchiveBrowseResult {
  objects: ArchivedObjectSummary[];
  warnings: string[];
}

export interface ArchivedFileEntry {
  relPath: string;
  isSubframe: boolean;
  bytes: number;
  presentLocally: boolean;
}

export interface ArchivedFileListResult {
  files: ArchivedFileEntry[];
  warnings: string[];
}

export async function listArchivedObjects(config: ArchiveConfig): Promise<ArchiveBrowseResult> {
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) return { objects: [], warnings: [readiness.warning] };

  const manifest = readArchiveManifest(readiness.root, config.archiveId);
  const objectIdByFolder = new Map<string, string>();
  for (const object of getLibraryObjectNames()) objectIdByFolder.set(object.folderName, object.objectId);

  const objects: ArchivedObjectSummary[] = [];

  for (const [folderName, entry] of Object.entries(manifest.objects)) {
    const objectId = objectIdByFolder.get(folderName) ?? null;
    const objDir = objectId === null ? null : resolveContainedObjectDir(objectId);

    let bytes = 0;
    let missingLocally = 0;
    let subframes = 0;

    for (const file of entry.files) {
      if (file.isSubframe) subframes++;

      const archivedAbs = resolveContainedArchivePath(readiness.root, folderName, ...file.relPath.split('/'));
      if (archivedAbs !== null && isFile(archivedAbs)) {
        try {
          bytes += fs.statSync(archivedAbs).size;
        } catch {
          // Vanished between the resolve and the stat. Not worth failing a browse.
        }
      }

      const localAbs = objectId !== null && objDir !== null
        ? localPathFor(objectId, objDir, file.relPath)
        : entry.objectId === '' ? rootFolderPathFor(folderName, file.relPath) : null;
      if (!isFile(localAbs)) missingLocally++;
    }

    objects.push({
      folderName,
      objectId,
      firstArchivedAt: entry.firstArchivedAt,
      lastArchivedAt: entry.lastArchivedAt,
      filesTotal: entry.files.length,
      subframes,
      bytes,
      missingLocally,
    });
  }

  objects.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return { objects, warnings: [] };
}

export async function listArchivedFiles(
  config: ArchiveConfig,
  folderName: string,
): Promise<ArchivedFileListResult> {
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) return { files: [], warnings: [readiness.warning] };

  const manifest = readArchiveManifest(readiness.root, config.archiveId);
  const entry = manifest.objects[folderName];
  if (!entry) return { files: [], warnings: [] };

  const objectIdByFolder = new Map<string, string>();
  for (const object of getLibraryObjectNames()) objectIdByFolder.set(object.folderName, object.objectId);
  const objectId = objectIdByFolder.get(folderName) ?? null;
  const objDir = objectId === null ? null : resolveContainedObjectDir(objectId);

  const files: ArchivedFileEntry[] = entry.files.map(file => {
    const archivedAbs = resolveContainedArchivePath(readiness.root, folderName, ...file.relPath.split('/'));
    let bytes = 0;
    if (archivedAbs !== null && isFile(archivedAbs)) {
      try {
        bytes = fs.statSync(archivedAbs).size;
      } catch {
        // As above: a file that disappeared mid-browse is reported as zero bytes
        // rather than failing the whole listing.
      }
    }
    const localAbs = objectId !== null && objDir !== null
      ? localPathFor(objectId, objDir, file.relPath)
      : entry.objectId === '' ? rootFolderPathFor(folderName, file.relPath) : null;
    return { relPath: file.relPath, isSubframe: file.isSubframe, bytes, presentLocally: isFile(localAbs) };
  });

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, warnings: [] };
}
