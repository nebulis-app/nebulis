/**
 * User preferences data access helpers.
 *
 * Encapsulates all direct DB access for the userPreferences table so route
 * handlers do not reach for db.prepare() themselves.
 */
import db from './db.js';

interface WatermarkPresetRow {
  watermarkPresets: string;
}

const getWatermarkPresetsStmt = db.prepare<[string], WatermarkPresetRow>(
  'SELECT watermarkPresets FROM userPreferences WHERE userId = ?',
);

const upsertWatermarkPresetsStmt = db.prepare<[string, string]>(`
  INSERT INTO userPreferences (userId, watermarkPresets, updatedAt)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(userId) DO UPDATE
    SET watermarkPresets = excluded.watermarkPresets,
        updatedAt        = excluded.updatedAt
`);

/**
 * Return the saved watermark presets for the given user.
 * Returns an empty array when no presets have been saved yet.
 */
export function getWatermarkPresets(userId: string): unknown[] {
  const row = getWatermarkPresetsStmt.get(userId);
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.watermarkPresets);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Persist the full watermark presets array for the given user, replacing
 * any previously saved value.
 */
export function setWatermarkPresets(userId: string, presets: unknown[]): void {
  upsertWatermarkPresetsStmt.run(userId, JSON.stringify(presets));
}

// ─── Release-notes dismissal (lastSeenVersion) ──────────────────────────────
// Used by the "What's New" auto-popup: the frontend compares the user's
// lastSeenVersion to /meta/version on app load and shows the modal when they
// differ. "Got it" updates this column; "Remind me later" leaves it alone.

interface LastSeenVersionRow {
  lastSeenVersion: string | null;
}

const getLastSeenVersionStmt = db.prepare<[string], LastSeenVersionRow>(
  'SELECT lastSeenVersion FROM userPreferences WHERE userId = ?',
);

const upsertLastSeenVersionStmt = db.prepare<[string, string]>(`
  INSERT INTO userPreferences (userId, lastSeenVersion, updatedAt)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(userId) DO UPDATE
    SET lastSeenVersion = excluded.lastSeenVersion,
        updatedAt       = excluded.updatedAt
`);

/** Return the version the user last acknowledged in the What's New popup, or
 *  null if they've never seen it. NULL on first-ever login surfaces the
 *  modal the first time they sign in. */
export function getLastSeenVersion(userId: string): string | null {
  const row = getLastSeenVersionStmt.get(userId);
  return row?.lastSeenVersion ?? null;
}

/** Mark `version` as acknowledged for this user. Idempotent. */
export function setLastSeenVersion(userId: string, version: string): void {
  upsertLastSeenVersionStmt.run(userId, version);
}
