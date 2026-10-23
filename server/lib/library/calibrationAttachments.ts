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
import type { AttachableCalibrationType, CalibrationAttachment, CalibrationAttachmentSummary } from './calibrationAttachmentTypes.js';

export type { AttachableCalibrationType, CalibrationAttachment, CalibrationAttachmentSummary } from './calibrationAttachmentTypes.js';

export function isAttachableCalibrationType(type: CalibrationFrameType | 'mixed'): type is AttachableCalibrationType {
  return type === 'flat' || type === 'flatDark';
}

/** Sentinel stored in the `date` column for "applies to every session of
 *  this object that has no more specific attachment of its own" — see
 *  db.ts's schema comment for why this is `''` rather than `NULL`. */
export const WHOLE_OBJECT_DATE = '';

interface AttachmentRow {
  id: string;
  objectId: string;
  date: string;
  /** Only ever written by attachCalibrationBundle, whose input is typed
   *  AttachableCalibrationType, so the column holds nothing else. */
  calibrationType: AttachableCalibrationType;
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
    calibrationType: row.calibrationType,
    scope: row.scope,
    folderName: row.folderName,
    settingsKey: row.settingsKey,
    createdAt: row.createdAt,
  };
}

// Exactly one bundle within a slot. `scope IS ?` for the same NULL reason as
// selectForBundleStmt below.
const selectSlotStmt = db.prepare<[string, string, string, string | null, string, string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? AND date = ? AND calibrationType = ? AND scope IS ? AND folderName = ? AND settingsKey = ?',
);

// Every bundle in a slot — a slot can hold several (e.g. one flat set per filter).
const selectSlotBundlesStmt = db.prepare<[string, string, string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? AND date = ? AND calibrationType = ? ORDER BY createdAt, id',
);

const selectByIdStmt = db.prepare<[string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE id = ?',
);

const selectForObjectStmt = db.prepare<[string], AttachmentRow>(
  'SELECT * FROM calibrationAttachments WHERE objectId = ? ORDER BY date, calibrationType',
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
  ON CONFLICT(objectId, date, calibrationType, COALESCE(scope, ''), folderName, settingsKey) DO UPDATE SET
    createdAt = excluded.createdAt
`);

const deleteStmt = db.prepare<[string]>('DELETE FROM calibrationAttachments WHERE id = ?');

/**
 * Attach a calibration bundle to one object, optionally scoped to one
 * specific session date. Attaching the same bundle again is a no-op that
 * keeps the row's id and refreshes `createdAt`. Attaching a *different*
 * bundle of the same type (a second filter's flats, say) adds a row next to
 * the first rather than replacing it — a multi-filter rig needs both. To
 * swap one bundle for another, detach the old one by id first.
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
  // Re-select rather than trust the freshly-generated id: attaching a bundle
  // that is already attached keeps that row's original id (ON CONFLICT UPDATE
  // never touches the primary key).
  const row = selectSlotStmt.get(input.objectId, date, input.calibrationType, input.scope, input.folderName, input.settingsKey);
  if (!row) throw new Error(`[calibrationAttachments] row for ${input.objectId}/${date} missing right after upsert`);
  return toAttachment(row);
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
 * The attachments that apply to one specific session, per calibration type.
 * If the session has any attachment of its own for a type, those are the
 * answer for that type and the whole-object ones are ignored — so a user can
 * override just one night's flats without disturbing every other session's.
 * Otherwise the whole-object attachments apply. A type can resolve to several
 * bundles (one flat set per filter).
 */
export function resolveAttachmentsForSession(objectId: string, date: string): CalibrationAttachment[] {
  const types: AttachableCalibrationType[] = ['flat', 'flatDark'];
  const out: CalibrationAttachment[] = [];
  for (const type of types) {
    const specific = date !== WHOLE_OBJECT_DATE ? selectSlotBundlesStmt.all(objectId, date, type) : [];
    const rows = specific.length > 0 ? specific : selectSlotBundlesStmt.all(objectId, WHOLE_OBJECT_DATE, type);
    out.push(...rows.map(toAttachment));
  }
  return out;
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
