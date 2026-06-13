/**
 * Persistent state for installed catalog packs.
 *
 * catalogPackState tracks which tier version is installed so Phase 0 can
 * skip tiers that are already up-to-date and report what's on disk.
 */

import db from '../db.js';
import type { CatalogTier } from './manifest.js';

export interface PackStateRow {
  tier:        CatalogTier;
  version:     string;
  installedAt: number;
  objectCount: number;
}

const getStateStmt = db.prepare<[string], PackStateRow>(
  'SELECT tier, version, installedAt, objectCount FROM catalogPackState WHERE tier = ?',
);

const upsertStateStmt = db.prepare(
  `INSERT INTO catalogPackState (tier, version, installedAt, objectCount)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(tier) DO UPDATE SET
     version     = excluded.version,
     installedAt = excluded.installedAt,
     objectCount = excluded.objectCount`,
);

const getAllStateStmt = db.prepare<[], PackStateRow>(
  'SELECT tier, version, installedAt, objectCount FROM catalogPackState ORDER BY tier',
);

const clearStateStmt = db.prepare('DELETE FROM catalogPackState');

export function getPackState(tier: CatalogTier): PackStateRow | null {
  return getStateStmt.get(tier) ?? null;
}

export function setPackState(tier: CatalogTier, version: string, objectCount: number): void {
  upsertStateStmt.run(tier, version, Date.now(), objectCount);
}

export function getAllPackStates(): PackStateRow[] {
  return getAllStateStmt.all();
}

export function clearPackState(): void {
  clearStateStmt.run();
}
