/**
 * The one writer of an `importHistory` row.
 *
 * `runImport` and `commitFolderImport` each carried a byte-identical
 * 17-positional-arg `stmts.insertHistory.run(...)` call plus a
 * `logSyncHistoryEvent(...)` call; the two sub-frame sync paths carried
 * neither, so a user who pulled 400 sub-frames saw nothing in Sync History
 * (CORE-PIPELINE-AUDIT High-1/High-4). This module owns both, and all four
 * import entry points call it.
 */
import { logEvent } from '../systemLog.js';
import { stmts } from './objects.js';
import type { ImportStatus, TouchedObject, TouchedSession } from './importTypes.js';

export type ImportHistorySource = 'telescope' | 'folder' | 'subframe';

export interface ImportHistoryAccumulators {
  /** Files added this run, in the order they landed. */
  newFiles: Array<{ name: string; size: number }>;
  bytesNew: number;
  objectsTouched: Map<string, TouchedObject>;
  sessionsTouched: Map<string, TouchedSession>;
  source: ImportHistorySource;
}

/**
 * System-log summary of a finished run. Only surfaces runs worth an admin's
 * attention — the same "worth surfacing" rule as `stmts.getHistory` (new
 * files, an error, or the user explicitly asked for it) so a routine
 * scheduled tick that finds nothing new stays silent.
 */
function logSyncHistoryEvent(source: ImportHistorySource, status: ImportStatus, newFilesCount: number): void {
  const worthSurfacing = newFilesCount > 0 || status.error !== null || status.manual;
  if (!worthSurfacing) return;

  const level: 'info' | 'warning' | 'error' = status.cancelled ? 'warning' : status.error ? 'error' : 'info';
  const originLabel = source === 'folder'
    ? 'a local folder'
    : source === 'subframe'
      ? `${status.telescopeName ?? 'a telescope'} (sub-frames)`
      : (status.telescopeName ?? 'a telescope');
  const trigger = status.manual ? 'Manual' : 'Scheduled';

  let message: string;
  if (status.cancelled) {
    message = `${trigger} sync from ${originLabel} was cancelled.`;
  } else if (status.error) {
    message = `${trigger} sync from ${originLabel} failed: ${status.error}`;
  } else {
    message = `${trigger} sync from ${originLabel} completed: ${newFilesCount} new file${newFilesCount !== 1 ? 's' : ''}.`;
  }

  logEvent({
    category: 'sync',
    event: source === 'folder' ? 'folder_import_finished' : 'sync_finished',
    level,
    message,
    metadata: {
      telescopeId: status.telescopeId,
      telescopeName: status.telescopeName,
      transportKind: status.transportKind,
      newFiles: newFilesCount,
      objectsTotal: status.objectsTotal,
      filesTotal: status.filesTotal,
      manual: status.manual,
      cancelled: status.cancelled,
      error: status.error,
    },
  });
}

/**
 * Insert the `importHistory` row for a finished run and emit its system-log
 * summary. Swallows its own failure with a warning, as both call sites did.
 */
export function writeImportHistory(status: ImportStatus, acc: ImportHistoryAccumulators): void {
  const newFilesCount = acc.newFiles.length;
  try {
    stmts.insertHistory.run(
      status.startedAt,
      new Date().toISOString(),
      status.objectsTotal,
      status.filesTotal,
      newFilesCount,
      status.bytesTotal,
      acc.bytesNew,
      status.error || null,
      newFilesCount > 0 ? JSON.stringify(acc.newFiles.map(f => f.name)) : null,
      status.telescopeId,
      status.telescopeName,
      status.transportKind,
      status.skipped.length > 0 ? JSON.stringify(status.skipped) : null,
      status.manual ? 1 : 0,
      status.cancelled ? 1 : 0,
      acc.objectsTouched.size > 0 ? JSON.stringify(Array.from(acc.objectsTouched.values())) : null,
      acc.sessionsTouched.size > 0 ? JSON.stringify(Array.from(acc.sessionsTouched.values())) : null,
    );
  } catch (err) {
    console.warn('[import] insertHistory failed:', err instanceof Error ? err.message : err);
  }
  try {
    logSyncHistoryEvent(acc.source, status, newFilesCount);
  } catch (err) {
    console.warn('[import] sync-history log failed:', err instanceof Error ? err.message : err);
  }
}
