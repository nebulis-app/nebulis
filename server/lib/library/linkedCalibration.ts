/**
 * Calibration frames that live inside a linked folder.
 *
 * A linked folder is read where it is, never copied, so its Darks, Flats, Bias or CALI_FRAME folders are not in the
 * archive the Calibration Library reads. The scan of the link (sourceWalk.ts) notes where they are and stores the
 * list with the source; this reads that list back. Nothing here touches the disk: the Calibration Library walks each
 * folder itself, and never writes to one.
 */
import path from 'path';
import db from '../db.js';
import { parseJsonRecord } from '../typeGuards.js';

/** The `scope` of a Calibration Library group that comes from a linked folder: `@src/<sourceId>`, the same prefix a
 *  linked file's library path carries. It can never be a telescope id, so it cannot collide with one. */
export const LINKED_SCOPE_PREFIX = '@src/';

export const linkedScopeFor = (sourceId: string): string => `${LINKED_SCOPE_PREFIX}${sourceId}`;
export const isLinkedScope = (scope: string | null): boolean => scope !== null && scope.startsWith(LINKED_SCOPE_PREFIX);

export interface LinkedCalibrationFolder {
  sourceId: string;
  sourceLabel: string;
  /** Posix, relative to the linked folder's root: `Calibration/Darks`. Doubles as the group's folder name. */
  relDir: string;
  /** Absolute path on the server. */
  absDir: string;
}

const enabledSourcesStmt = db.prepare<[], { id: string; label: string; rootPath: string; lastScanStats: string | null }>(
  'SELECT id, label, rootPath, lastScanStats FROM librarySources WHERE enabled = 1 ORDER BY createdAt ASC',
);

/** A stored directory is relative and stays inside the root: anything else in the JSON is ignored, not trusted. */
function safeRelDir(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  return parts.some(p => p === '' || p === '.' || p === '..') ? null : rel;
}

/** Every calibration folder the enabled linked folders last reported. A link made before this was recorded reports
 *  none until its next rescan. */
export function listLinkedCalibrationFolders(): LinkedCalibrationFolder[] {
  const out: LinkedCalibrationFolder[] = [];
  for (const source of enabledSourcesStmt.all()) {
    const dirs = source.lastScanStats ? parseJsonRecord(source.lastScanStats)?.calibrationDirs : null;
    if (!Array.isArray(dirs)) continue;
    for (const raw of dirs) {
      const relDir = safeRelDir(raw);
      if (relDir) out.push({ sourceId: source.id, sourceLabel: source.label, relDir, absDir: path.join(source.rootPath, ...relDir.split('/')) });
    }
  }
  return out;
}
