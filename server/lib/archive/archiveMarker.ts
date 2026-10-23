/**
 * Archive disk identity: the `.nebulisarchive` marker.
 *
 * This is what makes a destination "sticky". The same physical disk plugged in
 * at a different mount point is still our archive, and a *different* disk
 * plugged in at the same mount point is not. Both directions matter:
 *
 *  - Without the first, moving a disk would orphan every archived file.
 *  - Without the second, retention would eventually prune whatever happened to
 *    be mounted at the configured path, which is the external archive feature's
 *    highest-ranked risk.
 *
 * Modelled on `libraryPath.ts`'s library marker, with one deliberate difference.
 * That parser returns `null` for both "absent" and "invalid", which is enough for
 * its boolean `isLibraryAvailable()` check. Here the states have to be
 * distinguishable, because they call for different responses:
 *
 *   absent     set up a new archive
 *   match      proceed
 *   foreign    offer to adopt it, naming what was found
 *   invalid    refuse, and tell the user the marker is not one we recognise
 *   unreadable refuse; something is wrong with the file itself
 *
 * Collapsing `invalid` into `absent` would be the dangerous one: a disk holding
 * an unrecognisable marker would look empty, and the next run would write over
 * whatever an earlier or newer version of Nebulis had put there.
 *
 * Reads are side-effect free by construction. Nothing in this module creates,
 * repairs, or replaces a marker except `writeArchiveMarker`, which callers invoke
 * only after an explicit decision (adoption). `archiveMarker.test.ts` asserts
 * that reading leaves a foreign or invalid marker byte-identical.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { DATA_DIR } from '../paths.js';
import { parseJsonRecord } from '../typeGuards.js';
import { errnoCode } from '../errors.js';

export const ARCHIVE_MARKER_FILENAME = '.nebulisarchive';

export interface ArchiveMarker {
  archiveId: string;
  // Optional at the type level, matching LibraryMarker: readArchiveMarker only
  // validates archiveId (the only field any caller reads), so the type should
  // not claim a guarantee the parser does not enforce.
  createdAt?: string;
  appVersion?: string;
  note?: string;
}

/** The outcome of comparing a destination's marker against our own id. */
export type ArchiveMarkerState =
  | { state: 'match'; marker: ArchiveMarker }
  | { state: 'absent' }
  | { state: 'foreign'; marker: ArchiveMarker }
  | { state: 'invalid' }
  | { state: 'unreadable' };

/** A fresh archive identity. Generated on adoption, persisted with the config. */
export function newArchiveId(): string {
  return randomUUID();
}

/** Best-effort app version for the marker. Informational only, so a failure to
 *  read it is not an error: the marker's job is identity, not provenance. */
function readAppVersion(): string {
  try {
    const pkg = parseJsonRecord(fs.readFileSync(path.join(DATA_DIR, '..', 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/**
 * Build an ArchiveMarker from marker-file text, or null if this is not a marker
 * we recognise.
 *
 * Every field is copied through a type check rather than the parsed blob being
 * asserted. The file lives on removable media that any other machine can write,
 * so `{"archiveId": 42}` must be rejected here rather than flowing into an id
 * comparison as a non-string. This is the same reasoning (and the same historical
 * bug) as `parseMarker` in `libraryPath.ts`.
 */
export function parseArchiveMarker(text: string): ArchiveMarker | null {
  const parsed = parseJsonRecord(text);
  if (!parsed) return null;
  const { archiveId, createdAt, appVersion, note } = parsed;
  if (typeof archiveId !== 'string' || archiveId.length === 0) return null;
  return {
    archiveId,
    createdAt: typeof createdAt === 'string' ? createdAt : undefined,
    appVersion: typeof appVersion === 'string' ? appVersion : undefined,
    note: typeof note === 'string' ? note : undefined,
  };
}

/**
 * Compare the marker at `dir` against `expectedArchiveId`.
 *
 * An empty `expectedArchiveId` (archiving configured but no id assigned yet)
 * can never match, so it reports `foreign`. An install that has not adopted an
 * archive yet must not silently take over a disk that already holds one.
 */
export function readArchiveMarker(dir: string, expectedArchiveId: string): ArchiveMarkerState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ARCHIVE_MARKER_FILENAME), 'utf8');
  } catch (err) {
    // Only ENOENT means "no archive here". Anything else (permissions, the path
    // being a directory, an I/O error on a failing disk) is a refusal, so a
    // transient fault cannot be mistaken for an empty disk.
    const code = errnoCode(err);
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }

  const marker = parseArchiveMarker(text);
  if (!marker) return { state: 'invalid' };

  return marker.archiveId === expectedArchiveId
    ? { state: 'match', marker }
    : { state: 'foreign', marker };
}

/**
 * Write (or replace) the marker at `dir`.
 *
 * The directory is expected to exist: adoption runs against a folder the user
 * picked, and creating directories implicitly here would mean a typo in a
 * destination path could create a tree somewhere unexpected. Throwing on a
 * missing directory is the safer failure.
 *
 * Calling this against a foreign marker is exactly how adoption works, which is
 * why the read path never calls it.
 */
export function writeArchiveMarker(dir: string, archiveId: string): void {
  const marker: ArchiveMarker = {
    archiveId,
    createdAt: new Date().toISOString(),
    appVersion: readAppVersion(),
    note: 'This folder holds a Nebulis archive. Do not rename or delete files here.',
  };
  fs.writeFileSync(path.join(dir, ARCHIVE_MARKER_FILENAME), JSON.stringify(marker, null, 2), 'utf8');
}
