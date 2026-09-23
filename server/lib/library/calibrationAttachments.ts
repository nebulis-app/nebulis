/**
 * Links flat/flat-dark calibration bundles (calibrationScan.ts) to the
 * library object/session they were captured for.
 *
 * On a cooled camera, bias and darks are stable across sessions (same gain/
 * exposure/temperature → the same dark current and read noise months later),
 * so the Calibration Library treats them as a shared, reusable pool — that is
 * the whole point of organizing them by settings rather than by session.
 * Flats (and their matching flat-darks) are the opposite: they correct for
 * the optical train's state *at capture time* — dust motes, focus position,
 * camera/filter-wheel rotation — which drifts session to session, so a flat
 * set is really only valid for the session(s) it was shot for. Most rigs
 * shoot a fresh set at the end of each session specifically because of this.
 *
 * This module is a pointer table, not a copy: attaching a bundle does not
 * move or duplicate any bytes, it only records "this bundle belongs to this
 * object/session" so it can be found again later (and, eventually, bundled
 * alongside that session's lights for reprocessing). Deliberately kept out of
 * calibrationScan.ts itself, which stays a pure filesystem read with no
 * database — this is the one place in the calibration feature that needs one.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { stmts as objectStmts } from './objects.js';
import { findCalibrationBundle } from './calibrationScan.js';
import type { CalibrationFrameType } from './calibrationFolders.js';

/** Only flats and flat-darks are session-specific enough to need this — see
 *  the file header. Attaching a bias/dark/mixed bundle is rejected upstream
 *  (the route layer), not silently allowed here. */
export type AttachableCalibrationType = Extract<CalibrationFrameType, 'flat' | 'flatDark'>;

export function isAttachableCalibrationType(type: CalibrationFrameType | 'mixed'): type is AttachableCalibrationType {
  return type === 'flat' || type === 'flatDark';
}

/** Sentinel stored in the `date` column for "applies to every session of
 *  this object that has no more specific attachment of its own" — see
 *  db.ts's schema comment for why this is `''` rather than `NULL`. */
export const WHOLE_OBJECT_DATE = '';

export interface CalibrationAttachment {
  id: string;
  objectId: string;
  /** '' means "whole object" — see WHOLE_OBJECT_DATE. */
  date: string;
  calibrationType: AttachableCalibrationType;
  scope: string | null;
  folderName: string;
  settingsKey: string;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  objectId: string;
  date: string;
  calibrationType: string;
  scope: string | null;
  folderName: string;
  settingsKey: string;
  createdAt: string;
}

function toAttachment(row: AttachmentRow): CalibrationAttachment {
  return {
    id: row.id,
    objectId: row.objectId,
    date: row.date,
    calibrationType: row.calibrationType as AttachableCalibrationType,
    scope: row.scope,
    folderName: row.folderName,
    settingsKey: row.settingsKey,
    createdAt: row.createdAt,
  };
}

const selectSlotStmt = db.prepare<[string, string, string, string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? AND date = ? AND calibrationType = ? AND settingsKey = ?',
);

const selectByIdStmt = db.prepare<[string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE id = ?',
);

const selectForObjectStmt = db.prepare<[string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? ORDER BY date, calibrationType',
);

// All bundles attached to (objectId, date, calibrationType) regardless of settingsKey —
// used by resolveAttachmentsForSession where the settingsKey is not known upfront.
const selectBySlotTypeStmt = db.prepare<[string, string, string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? AND date = ? AND calibrationType = ? ORDER BY createdAt',
);

// `scope IS ?` rather than `= ?`: scope is nullable (the shared unscoped
// archive bucket), and SQL `NULL = NULL` is never true, which would silently
// stop this from ever matching an unscoped bundle's attachment. `IS` treats a
// bound NULL parameter as "IS NULL" the way JS `===` would.
const selectForBundleStmt = db.prepare<[string | null, string, string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE scope IS ? AND folderName = ? AND settingsKey = ?',
);

const upsertStmt = db.prepare<[string, string, string, string, string | null, string, string, string]>(`
  INSERT INTO calibrationAttachments (id, objectId, date, calibrationType, scope, folderName, settingsKey, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(objectId, date, calibrationType, settingsKey) DO UPDATE SET
    scope = excluded.scope,
    folderName = excluded.folderName,
    createdAt = excluded.createdAt
`);

const deleteStmt = db.prepare<[string]>('DELETE FROM calibrationAttachments WHERE id = ?');

/**
 * Attach (or re-attach — "reattach" per the feature request) a calibration
 * bundle to one object, optionally scoped to one specific session date.
 * Idempotent per (objectId, date, calibrationType, settingsKey) slot:
 * attaching the same bundle twice to the same object/date is a no-op that
 * refreshes `createdAt`. Attaching a *different* bundle of the same type
 * (e.g. a second flat bundle for a different filter) creates a new row
 * rather than replacing the first — multiple distinct flat bundles can
 * coexist on the same object. To replace a specific attached bundle,
 * detach it by id first, then attach the replacement.
 *
 * `date` omitted or `null` attaches at the whole-object level. Does not
 * validate that `objectId` exists or that the bundle itself still exists —
 * both are the route layer's job (it already has to look the bundle up via
 * `findCalibrationBundle` to reject a non-flat/flat-dark type, so re-deriving
 * that check here would just be a second, easy-to-drift copy of it).
 */
export function attachCalibrationBundle(input: {
  objectId: string;
  date?: string | null;
  calibrationType: AttachableCalibrationType;
  scope: string | null;
  folderName: string;
  settingsKey: string;
}): CalibrationAttachment {
  const date = input.date ?? WHOLE_OBJECT_DATE;
  upsertStmt.run(
    randomUUID(),
    input.objectId,
    date,
    input.calibrationType,
    input.scope,
    input.folderName,
    input.settingsKey,
    new Date().toISOString(),
  );
  // Re-select rather than trust the freshly-generated id: a re-attach into an
  // already-occupied slot keeps that row's original id (ON CONFLICT UPDATE
  // never touches the primary key), which is correct — the slot's identity
  // persists across a reattach, only its target bundle changes.
  return toAttachment(selectSlotStmt.get(input.objectId, date, input.calibrationType, input.settingsKey)!);
}

/** True if a row was deleted. */
export function detachCalibrationBundle(id: string): boolean {
  return deleteStmt.run(id).changes > 0;
}

export function getAttachment(id: string): CalibrationAttachment | null {
  const row = selectByIdStmt.get(id);
  return row ? toAttachment(row) : null;
}

/** Every attachment on one object, across every session and the whole-object
 *  slot — for an object-level "what's attached" overview. */
export function listAttachmentsForObject(objectId: string): CalibrationAttachment[] {
  return selectForObjectStmt.all(objectId).map(toAttachment);
}

/**
 * The attachment that applies to one specific session, per calibration type
 * — session-specific attachments win over whole-object ones for the same
 * type and settingsKey, so a user can override just one night's flats
 * without disturbing every other session's. Multiple bundles of the same
 * type (e.g. H-alpha flats + SII flats) are all returned: every flat and
 * flat-dark bundle attached to this session, whether session-specific or
 * whole-object, comes back.
 */
export function resolveAttachmentsForSession(objectId: string, date: string): CalibrationAttachment[] {
  const types: AttachableCalibrationType[] = ['flat', 'flatDark'];
  const out: CalibrationAttachment[] = [];
  for (const type of types) {
    // Prefer session-specific attachments; fall back to whole-object ones for any
    // settingsKeys not covered at the session level.
    const specific = date !== WHOLE_OBJECT_DATE ? selectBySlotTypeStmt.all(objectId, date, type) : [];
    const specificKeys = new Set(specific.map(r => r.settingsKey));
    const wholeObject = selectBySlotTypeStmt
      .all(objectId, WHOLE_OBJECT_DATE, type)
      .filter(r => !specificKeys.has(r.settingsKey));
    out.push(...[...specific, ...wholeObject].map(toAttachment));
  }
  return out;
}

export interface CalibrationAttachmentSummary extends CalibrationAttachment {
  /** Display name for the attached object, or its folder name when it has no
   *  resolved catalog name — never absent, so the UI never has to fall back
   *  to a bare id. */
  objectName: string;
}

/** Every place (object, and optionally a specific session) one exact bundle
 *  is currently attached to, with the object's display name resolved —
 *  what the Calibration Library page shows next to a flats/flat-darks row.
 *  Silently drops an attachment whose object was since deleted rather than
 *  erroring: a dangling pointer here is display-only staleness, not data
 *  loss (`ON DELETE CASCADE` on the object row already prevents this in
 *  practice, but a soft-deleted object is a real case this still guards). */
export function findAttachmentsForBundle(
  scope: string | null,
  folderName: string,
  settingsKey: string,
): CalibrationAttachmentSummary[] {
  const rows = selectForBundleStmt.all(scope, folderName, settingsKey);
  const out: CalibrationAttachmentSummary[] = [];
  for (const row of rows) {
    const attachment = toAttachment(row);
    const obj = objectStmts.getObject.get(attachment.objectId);
    if (!obj || obj.deleted) continue;
    out.push({ ...attachment, objectName: obj.objectName ?? obj.folderName });
  }
  return out;
}

/** Re-validates that an attachment's bundle still exists in the archive
 *  (the user may have deleted/moved files since attaching) — used by the
 *  route layer to decide whether to surface a "missing" state rather than
 *  silently pretending the pointer is still good. */
export function attachmentBundleStillExists(attachment: CalibrationAttachment): boolean {
  return findCalibrationBundle(attachment.scope, attachment.folderName, attachment.settingsKey) !== null;
}
