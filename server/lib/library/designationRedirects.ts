/**
 * Per-designation redirects created by the "Reclassify object" action
 * (Object Detail → "..." menu). resolveCanonicalId() answers "what does the
 * catalog say this designation is", which is fixed data; a redirect is a
 * user correction layered on top of it for one specific designation that kept
 * resolving to the wrong object. Consulted at the two import chokepoints in
 * import.ts that call resolveCanonicalId to pick a file's destination object.
 */
import db from '../db.js';
import { normalizeDesignation } from '../catalogAliases.js';

const getStmt = db.prepare<[string], { targetObjectId: string }>(
  'SELECT targetObjectId FROM objectDesignationRedirects WHERE designation = ?',
);
const setStmt = db.prepare(
  `INSERT INTO objectDesignationRedirects (designation, targetObjectId, createdAt, createdBy)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(designation) DO UPDATE SET targetObjectId = excluded.targetObjectId,
     createdAt = excluded.createdAt, createdBy = excluded.createdBy`,
);
const listStmt = db.prepare<[], { designation: string; targetObjectId: string; createdAt: string }>(
  'SELECT designation, targetObjectId, createdAt FROM objectDesignationRedirects ORDER BY designation',
);
const deleteStmt = db.prepare('DELETE FROM objectDesignationRedirects WHERE designation = ?');

function normalize(designation: string): string {
  return normalizeDesignation(designation).toUpperCase().replace(/\s+/g, '');
}

/** Returns the redirected target objectId for this designation, or null if none is set. */
export function getDesignationRedirect(designation: string): string | null {
  const row = getStmt.get(normalize(designation));
  return row?.targetObjectId ?? null;
}

export function setDesignationRedirect(designation: string, targetObjectId: string, userId?: string): void {
  setStmt.run(normalize(designation), targetObjectId, new Date().toISOString(), userId ?? null);
}

export function deleteDesignationRedirect(designation: string): void {
  deleteStmt.run(normalize(designation));
}

/** Every redirect, so the apps can show what "remember this" has been remembering. */
export function listDesignationRedirects(): { designation: string; targetObjectId: string; createdAt: string }[] {
  return listStmt.all();
}
