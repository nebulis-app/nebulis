/**
 * The Google Drive backup engine: the library, the gallery and the database, copied
 * to a folder in the user's Google Drive.
 *
 * This is a second destination, independent of the disk archive (see
 * gdriveBackupConfig.ts for why), with its own runner and schedule
 * (gdriveBackupRunner.ts). It keeps the promises the disk archive makes, in Drive's
 * terms:
 *
 *  - **The layout is mirrored.** `<folder>/<object>/<session>/<file>`, exactly as on
 *    a disk, so the folder can be downloaded and opened in Siril or PixInsight
 *    without Nebulis. That includes `<object>/processed/`, which is where the
 *    gallery's finished images live.
 *  - **The marker decides ownership.** `.nebulisarchive` in the folder carries the
 *    archive id, and nothing is written to a folder whose marker is not ours.
 *    Adopting is the only step that writes one, as on a disk.
 *  - **Nothing is recorded until it is verified.** Drive computes an MD5 (and, for
 *    newer files, a SHA-256) of what it received; a file is recorded only when that
 *    matches what was read locally. A resumable upload is invisible in Drive until
 *    its last byte lands, so there is no half-written file under the final name.
 *  - **The record is the same manifest**, stored as a Drive file, so the next run
 *    skips unchanged files without hashing them.
 *
 * And it adds one: **the Nebulis database goes too.** Each run takes a fresh
 * snapshot (`cloud` kind, see dbBackup.ts) and uploads every local snapshot that is
 * not in Drive yet into `.nebulis-database/`. The pre-upgrade and manual snapshots
 * are uploaded as soon as they are taken, through `uploadDatabaseBackupsToGdrive`.
 *
 * It never deletes library files from Drive: it is a backup that only adds. Pruning,
 * removing local subframes and restoring belong to the disk archive.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import { createHash } from 'crypto';

import { getGdriveBackupConfig, getGdriveBackupSecrets, gdriveSelectionConfig, type GdriveBackupConfig } from './gdriveBackupConfig.js';
import { ARCHIVE_MARKER_FILENAME, newArchiveId, parseArchiveMarker, type ArchiveMarkerState } from '../archiveMarker.js';
import {
  ARCHIVE_MANIFEST_BACKUP_FILENAME,
  ARCHIVE_MANIFEST_FILENAME,
  EMPTY_ARCHIVE_MANIFEST,
  mergeArchiveRun,
  parseArchiveManifestText,
  type ArchiveManifest,
  type ArchiveManifestFile,
} from '../archiveManifest.js';
import { selectArchiveFiles, type ArchiveCandidate } from '../archiveSelect.js';
import type { ArchiveRunProgress, ArchiveRunResult, KnownArchivedFile } from '../archiveCopy.js';
import { listDatabaseBackups, parseBackupName } from '../../dbBackup.js';
import { getCurrentVersion } from '../../appUpdate/platform.js';
import { logEvent } from '../../systemLog.js';
import { log } from '../../logger.js';
import { DriveError, FOLDER_MIME, type DriveClient, type DriveFile } from './driveClient.js';
import { GdriveAuthError, getGdriveClient } from './driveAuth.js';

/** Where database snapshots go inside the archive folder. Dot-prefixed, so it can
 *  never collide with a library folder: the selection leaves dot-prefixed entries out. */
export const GDRIVE_DATABASE_FOLDER = '.nebulis-database';

/** How many of the per-run `cloud` snapshots are kept in Drive. Upgrade and manual
 *  snapshots are few and are all kept. */
export const GDRIVE_CLOUD_SNAPSHOTS_KEPT = 30;

const MANIFEST_FLUSH_FILES = 500;
const MANIFEST_FLUSH_MS = 5 * 60_000;

export const GDRIVE_NOT_CONNECTED = 'Google Drive is not signed in. Connect it in Settings → Storage → Archive → Google Drive.';
export const GDRIVE_FOLDER_MISSING = 'The Google Drive backup folder was not found. Open Settings → Storage → Archive → Google Drive to prepare it again.';
const GDRIVE_NOT_OURS = 'That Google Drive folder is not this install’s backup.';

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Drive's answer when the client's Google Cloud project never turned the Drive API on
 *  (setup step 2). Sign-in still works then, so this is the first Drive call to notice. */
export const GDRIVE_API_DISABLED =
  'The Google Drive API is turned off in the Google Cloud project of this client. Turn it on (step 2 of the setup guide), wait a minute, then try again.';

function isApiDisabled(err: unknown): boolean {
  return err instanceof DriveError && err.reason === 'accessNotConfigured';
}

function message(err: unknown): string {
  if (isApiDisabled(err)) return GDRIVE_API_DISABLED;
  return err instanceof Error ? err.message : String(err);
}

/** "1.2 GB", "340 MB": for log lines a person reads while a run goes on. */
function readableBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** How often a long run logs where it stands, besides one line per file sent. */
const PROGRESS_LOG_MS = 60_000;

/** SHA-256 (the manifest's digest) and MD5 (what Drive reports for every file) in one read. */
export async function digestFile(filePath: string): Promise<{ sha256: string; md5: string }> {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of fs.createReadStream(filePath)) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new TypeError(`digestFile: unexpected non-Buffer chunk reading ${filePath}`);
    sha.update(bytes);
    md5.update(bytes);
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex') };
}

/**
 * SHA-256 and MD5 of a file from the chunks an upload reads, so a file that is sent
 * is read once instead of hashed first and read again. A resumed upload can read a
 * range again (Drive asks for the bytes after what it holds); each byte counts once,
 * in order. `result` is null when the chunks did not cover the file from 0 to its
 * end, and the caller then hashes the file the plain way.
 */
export class InOrderDigest {
  private readonly sha = createHash('sha256');
  private readonly md5 = createHash('md5');
  private hashedUpTo = 0;

  feed(start: number, chunk: Buffer): void {
    const end = start + chunk.length;
    if (start > this.hashedUpTo || end <= this.hashedUpTo) return;
    const fresh = chunk.subarray(this.hashedUpTo - start);
    this.sha.update(fresh);
    this.md5.update(fresh);
    this.hashedUpTo = end;
  }

  result(size: number): { sha256: string; md5: string } | null {
    if (this.hashedUpTo !== size) return null;
    return { sha256: this.sha.digest('hex'), md5: this.md5.digest('hex') };
  }
}

/** Whether Drive's account of an upload agrees with what was read locally. */
export function uploadMatches(uploaded: DriveFile, bytes: number, digests: { sha256: string; md5: string }): boolean {
  if (uploaded.size !== bytes) return false;
  if (uploaded.md5Checksum === undefined || uploaded.md5Checksum.toLowerCase() !== digests.md5) return false;
  // Newer Drive files also carry a SHA-256. When present it is checked too.
  if (uploaded.sha256Checksum !== undefined && uploaded.sha256Checksum.toLowerCase() !== digests.sha256) return false;
  return true;
}

/**
 * What the settings page shows as the destination: the folder's name and the account.
 * Not a path: under `drive.file` Nebulis cannot see the user's own folders, so it
 * cannot tell where the folder sits once the user moves it. `liveName` is the name
 * Drive reports now, which follows a rename; the name saved when the folder was
 * prepared is the fallback when Drive was not asked.
 */
export function gdriveDisplayPath(config: GdriveBackupConfig, liveName?: string): string {
  const account = config.account ? ` (${config.account})` : '';
  const name = liveName?.trim() || config.folderPath;
  return `Google Drive: ${name}${account}`;
}

// ─── The backup folder and its marker ───────────────────────────────────────

/**
 * The backup folder, by its stored id. Null when none has been prepared, or when this
 * sign-in cannot see it (moved to the bin, or another account). Nothing here creates
 * a folder: `prepareGdriveArchiveFolder` is the only place that does.
 */
export async function findArchiveFolder(client: DriveClient): Promise<DriveFile | null> {
  const { folderId } = getGdriveBackupSecrets();
  if (folderId === '') return null;
  const folder = await client.getFile(folderId);
  return folder && folder.mimeType === FOLDER_MIME ? folder : null;
}

export interface GdriveFolderEntry {
  id: string;
  name: string;
}

export class GdriveFolderError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'GdriveFolderError';
  }
}

function signedInClient(): DriveClient {
  const client = getGdriveClient();
  if (!client) throw new GdriveFolderError(GDRIVE_NOT_CONNECTED, 409, 'GDRIVE_NOT_CONNECTED');
  return client;
}

/** Turn the Drive errors a user can fix into a folder error with its own code. */
async function folderCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isApiDisabled(err)) throw new GdriveFolderError(GDRIVE_API_DISABLED, 409, 'GDRIVE_API_DISABLED');
    throw err;
  }
}

/** The folder Nebulis creates at the top of My Drive when none is chosen yet. */
export const GDRIVE_DEFAULT_FOLDER = 'Nebulis';

/**
 * The backup folder, made ready right after sign-in. There is no folder picker: with
 * the `drive.file` scope Nebulis could only ever list the folders it made itself.
 *
 * In order: the folder already chosen, wherever the user has since moved or renamed it
 * (it is kept by id); else a `Nebulis` folder at the top of My Drive that Nebulis made
 * earlier; else a new one there. Only the last case writes to Drive, and it writes an
 * empty folder. Nothing is saved here: the folder is saved with the backup settings.
 */
export async function prepareGdriveArchiveFolder(): Promise<{ folder: GdriveFolderEntry; created: boolean }> {
  const client = signedInClient();
  return folderCall(async () => {
    const current = await findArchiveFolder(client);
    if (current) return { folder: { id: current.id, name: current.name }, created: false };
    const [earlier] = await client.findByName('root', GDRIVE_DEFAULT_FOLDER, true);
    if (earlier) return { folder: { id: earlier.id, name: earlier.name }, created: false };
    const made = await client.createFolder('root', GDRIVE_DEFAULT_FOLDER);
    return { folder: { id: made.id, name: made.name }, created: true };
  });
}

type RemoteMarker = ArchiveMarkerState & { fileId?: string };

/** The marker in the archive folder, compared against our id. The same five states
 *  as on a disk, with "could not download it" as `unreadable`. */
export async function readRemoteMarker(client: DriveClient, folderId: string, expectedArchiveId: string): Promise<RemoteMarker> {
  const [file] = await client.findByName(folderId, ARCHIVE_MARKER_FILENAME);
  if (!file) return { state: 'absent' };
  let text: string;
  try {
    text = await client.downloadText(file.id);
  } catch {
    return { state: 'unreadable', fileId: file.id };
  }
  const marker = parseArchiveMarker(text);
  if (!marker) return { state: 'invalid', fileId: file.id };
  return marker.archiveId === expectedArchiveId && expectedArchiveId !== ''
    ? { state: 'match', marker, fileId: file.id }
    : { state: 'foreign', marker, fileId: file.id };
}

export type GdriveReadiness =
  | { ok: true; client: DriveClient; folderId: string }
  | { ok: false; warning: string };

/** The strict form, for every step that writes: signed in, folder found, marker ours. */
export async function ensureGdriveArchiveReady(config: GdriveBackupConfig): Promise<GdriveReadiness> {
  const client = getGdriveClient();
  if (!client) return { ok: false, warning: GDRIVE_NOT_CONNECTED };
  try {
    const folder = await findArchiveFolder(client);
    if (!folder) return { ok: false, warning: GDRIVE_FOLDER_MISSING };
    const marker = await readRemoteMarker(client, folder.id, config.archiveId);
    if (marker.state !== 'match') return { ok: false, warning: GDRIVE_NOT_OURS };
    return { ok: true, client, folderId: folder.id };
  } catch (err) {
    if (err instanceof GdriveAuthError) return { ok: false, warning: err.message };
    if (isApiDisabled(err)) return { ok: false, warning: GDRIVE_API_DISABLED };
    return { ok: false, warning: `Google Drive could not be reached: ${message(err)}` };
  }
}

export interface GdriveDestinationView {
  state: 'offline' | 'absent' | 'match' | 'foreign' | 'invalid' | 'unreadable';
  path: string;
  foundArchiveId: string | null;
}

/** Where the Drive destination stands, for the settings page. Reads only. A chosen
 *  folder without our marker is `absent`, which is what offers the adopt button; a
 *  folder that cannot be found (none chosen, or gone) is `offline`. */
export async function gdriveDestinationState(config: GdriveBackupConfig): Promise<GdriveDestinationView> {
  const path = gdriveDisplayPath(config);
  const client = getGdriveClient();
  if (!client) return { state: 'offline', path, foundArchiveId: null };
  try {
    const folder = await findArchiveFolder(client);
    if (!folder) return { state: 'offline', path, foundArchiveId: null };
    const marker = await readRemoteMarker(client, folder.id, config.archiveId);
    const foundArchiveId = marker.state === 'match' || marker.state === 'foreign' ? marker.marker.archiveId : null;
    return { state: marker.state, path: gdriveDisplayPath(config, folder.name), foundArchiveId };
  } catch {
    return { state: 'offline', path, foundArchiveId: null };
  }
}

export type GdriveAdoptResult =
  | { ok: true; archiveId: string; replacedArchiveId: string | null; previousRecordSetAside: boolean; path: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Claim the Drive folder as this install's backup by writing our marker. The same rules as adopting a disk: an unreadable marker is never
 * overwritten, and a foreign one only when the caller echoes its id back.
 */
export async function adoptGdriveArchive(config: GdriveBackupConfig, confirmArchiveId: unknown): Promise<GdriveAdoptResult> {
  const client = getGdriveClient();
  if (!client) return { ok: false, status: 400, code: 'GDRIVE_UNUSABLE', message: GDRIVE_NOT_CONNECTED };
  const path = gdriveDisplayPath(config);
  try {
    const folder = await findArchiveFolder(client);
    if (!folder) return { ok: false, status: 400, code: 'GDRIVE_UNUSABLE', message: GDRIVE_FOLDER_MISSING };
    const marker = await readRemoteMarker(client, folder.id, config.archiveId);

    if (marker.state === 'match') {
      return { ok: true, archiveId: config.archiveId, replacedArchiveId: null, previousRecordSetAside: false, path };
    }
    if (marker.state === 'invalid' || marker.state === 'unreadable') {
      return {
        ok: false,
        status: 409,
        code: 'GDRIVE_MARKER_UNREADABLE',
        message: 'The marker file in that Google Drive folder cannot be read, so it will not be overwritten. Remove it in Google Drive if you are sure.',
      };
    }
    if (marker.state === 'foreign' && (typeof confirmArchiveId !== 'string' || confirmArchiveId !== marker.marker.archiveId)) {
      return {
        ok: false,
        status: 409,
        code: 'GDRIVE_FOREIGN_CONFIRMATION_REQUIRED',
        message: `That Google Drive folder already holds another install’s backup (${marker.marker.archiveId}). Confirm that id to take it over.`,
      };
    }

    const archiveId = newArchiveId();
    const body = JSON.stringify(
      {
        archiveId,
        createdAt: new Date().toISOString(),
        appVersion: getCurrentVersion().version,
        note: 'This folder holds a Nebulis archive. Do not rename or delete files here.',
      },
      null,
      2,
    );
    await client.uploadBuffer(folder.id, ARCHIVE_MARKER_FILENAME, Buffer.from(body, 'utf8'), 'application/json', marker.fileId);

    // Another install's record describes history this one did not make. Set it
    // aside by renaming, as on a disk, so nothing here ever trusts it.
    let previousRecordSetAside = false;
    for (const name of [ARCHIVE_MANIFEST_FILENAME, ARCHIVE_MANIFEST_BACKUP_FILENAME]) {
      for (const file of await client.findByName(folder.id, name)) {
        await client.rename(file.id, `${name}.previous`);
        previousRecordSetAside = true;
      }
    }

    return {
      ok: true,
      archiveId,
      replacedArchiveId: marker.state === 'foreign' ? marker.marker.archiveId : null,
      previousRecordSetAside,
      path,
    };
  } catch (err) {
    if (err instanceof GdriveAuthError) return { ok: false, status: 400, code: 'GDRIVE_UNUSABLE', message: err.message };
    return { ok: false, status: 502, code: 'GDRIVE_ADOPT_FAILED', message: `Google Drive could not be reached: ${message(err)}` };
  }
}

// ─── Folder tree, cached for one run ────────────────────────────────────────

interface FolderListing {
  folders: Map<string, string>;
  files: Map<string, DriveFile>;
}

/** Folder ids and listings for one run, so a library of thousands of files costs one
 *  listing per folder rather than one search per file. */
export class DriveTree {
  private readonly listings = new Map<string, FolderListing>();
  private readonly pathIds = new Map<string, string>();

  constructor(
    private readonly client: DriveClient,
    rootId: string,
  ) {
    this.pathIds.set('', rootId);
  }

  async listing(folderId: string): Promise<FolderListing> {
    let listing = this.listings.get(folderId);
    if (!listing) {
      listing = { folders: new Map(), files: new Map() };
      // Oldest first, so where Drive holds two items with one name, every run settles
      // on the same one.
      const children = (await this.client.listChildren(folderId)).sort((a, b) =>
        (a.modifiedTime ?? '').localeCompare(b.modifiedTime ?? ''),
      );
      for (const child of children) {
        if (child.mimeType === FOLDER_MIME) {
          if (!listing.folders.has(child.name)) listing.folders.set(child.name, child.id);
        } else if (!listing.files.has(child.name)) {
          listing.files.set(child.name, child);
        }
      }
      this.listings.set(folderId, listing);
    }
    return listing;
  }

  /** The id of `segments` below the root, creating folders as needed. */
  async folderId(segments: string[]): Promise<string> {
    let key = '';
    let id = this.pathIds.get('') ?? '';
    for (const segment of segments) {
      const nextKey = key === '' ? segment : `${key}/${segment}`;
      let nextId = this.pathIds.get(nextKey);
      if (nextId === undefined) {
        const parent = await this.listing(id);
        nextId = parent.folders.get(segment);
        if (nextId === undefined) {
          nextId = (await this.client.createFolder(id, segment)).id;
          parent.folders.set(segment, nextId);
          // A folder this run just made is known to be empty.
          this.listings.set(nextId, { folders: new Map(), files: new Map() });
        }
        this.pathIds.set(nextKey, nextId);
      }
      key = nextKey;
      id = nextId;
    }
    return id;
  }
}

/** A path segment that cannot be a Drive folder or file name in the mirror. */
function badSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..';
}

// ─── The manifest, as a Drive file ──────────────────────────────────────────

type RemoteManifestRead =
  | { status: 'ok'; manifest: ArchiveManifest; fileId: string }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string };

async function readRemoteManifest(client: DriveClient, folderId: string, archiveId: string): Promise<RemoteManifestRead> {
  const [file] = await client.findByName(folderId, ARCHIVE_MANIFEST_FILENAME);
  if (!file) return { status: 'absent' };
  let text: string;
  try {
    text = await client.downloadText(file.id);
  } catch (err) {
    return { status: 'unreadable', reason: message(err) };
  }
  const manifest = parseArchiveManifestText(text);
  if (!manifest) return { status: 'unreadable', reason: 'the archive record is not valid' };
  if (manifest.archiveId !== undefined && archiveId !== '' && manifest.archiveId !== archiveId) {
    return { status: 'unreadable', reason: 'the archive record in this folder belongs to a different archive' };
  }
  return { status: 'ok', manifest, fileId: file.id };
}

// ─── One run ────────────────────────────────────────────────────────────────

export interface GdriveRunOptions {
  signal?: AbortSignal;
  /** Mirrors progress into the status route. */
  report: (patch: Partial<ArchiveRunProgress>) => void;
  /** Takes the run's database snapshot. Injected so this module does not import
   *  db.ts's live handle, and so tests can count it. */
  takeDatabaseSnapshot?: () => void;
}

function emptyResult(overrides: Partial<ArchiveRunResult>): ArchiveRunResult {
  return {
    ran: true,
    copied: 0,
    skipped: 0,
    tooYoungSkipped: 0,
    linkedSkipped: 0,
    cancelled: false,
    bytesCopied: 0,
    failures: [],
    warnings: [],
    ...overrides,
  };
}

/** Copy everything the configuration selects to the Drive folder, then the database. */
export async function runGdriveArchive(config: GdriveBackupConfig, options: GdriveRunOptions): Promise<ArchiveRunResult> {
  const { signal, report } = options;
  const readiness = await ensureGdriveArchiveReady(config);
  if (!readiness.ok) return emptyResult({ ran: false, reason: 'destination-unusable', warnings: [readiness.warning] });
  const { client, folderId: rootId } = readiness;

  let manifestRead: RemoteManifestRead;
  try {
    manifestRead = await readRemoteManifest(client, rootId, config.archiveId);
  } catch (err) {
    return emptyResult({ ran: false, reason: 'destination-unusable', warnings: [message(err)] });
  }
  if (manifestRead.status === 'unreadable') {
    // As on a disk: a record that exists and cannot be trusted is never replaced.
    return emptyResult({
      failures: [
        {
          archiveRelPath: '(manifest)',
          error: `the archive record in Google Drive could not be read (${manifestRead.reason}), so nothing was copied and the record was left as it is`,
        },
      ],
    });
  }
  let record: ArchiveManifest = {
    ...(manifestRead.status === 'ok' ? manifestRead.manifest : EMPTY_ARCHIVE_MANIFEST),
    archiveId: config.archiveId,
  };
  let manifestFileId = manifestRead.status === 'ok' ? manifestRead.fileId : undefined;

  const selection = selectArchiveFiles(gdriveSelectionConfig(config));
  report({ filesTotal: selection.candidates.length, bytesTotal: selection.bytesTotal, warnings: [...selection.warnings], phase: 'copying' });

  // What the record already knows, so an unchanged library is not re-hashed.
  const filesByFolder = new Map<string, Map<string, ArchiveManifestFile>>();
  const knownFor = (candidate: ArchiveCandidate): KnownArchivedFile | undefined => {
    const entry = record.objects[candidate.folderName];
    if (entry === undefined || entry.objectId !== candidate.objectId) return undefined;
    let index = filesByFolder.get(candidate.folderName);
    if (index === undefined) {
      index = new Map(entry.files.map(f => [f.relPath, f]));
      filesByFolder.set(candidate.folderName, index);
    }
    const file = index.get(candidate.relPath);
    if (file?.sha256 === undefined || file.bytes === undefined || file.mtimeMs === undefined) return undefined;
    return { bytes: file.bytes, mtimeMs: file.mtimeMs, sha256: file.sha256 };
  };

  // Quota preflight, against what probably still needs sending. Unlimited plans
  // report no limit, and are never refused.
  try {
    const needed = selection.candidates.reduce((sum, c) => {
      const known = knownFor(c);
      return known && known.bytes === c.bytes && known.mtimeMs === c.mtimeMs ? sum : sum + c.bytes;
    }, 0);
    const quota = await client.about();
    if (quota.limit !== null && needed > quota.limit - quota.usage) {
      const mb = (n: number): number => Math.round(n / 1024 ** 2);
      return emptyResult({
        ran: false,
        reason: 'insufficient-space',
        tooYoungSkipped: selection.tooYoungSkipped,
        linkedSkipped: selection.linkedSkipped,
        failures: [
          {
            archiveRelPath: '(space)',
            error: `this run needs about ${mb(needed)} MB and Google Drive has ${mb(Math.max(0, quota.limit - quota.usage))} MB free`,
          },
        ],
        warnings: selection.warnings,
      });
    }
  } catch (err) {
    if (err instanceof GdriveAuthError) return emptyResult({ ran: false, reason: 'destination-unusable', warnings: [err.message] });
    // The quota is advisory. A run that cannot read it carries on, and a full Drive
    // shows up as per-file failures instead.
  }

  const tree = new DriveTree(client, rootId);
  const failures: ArchiveRunResult['failures'] = [];
  let copied = 0;
  let skipped = 0;
  let bytesCopied = 0;
  let filesDone = 0;
  let bytesDone = 0;
  let cancelled = false;
  let connectionLost = false;
  let manifestFailed = false;
  let unrecorded: ArchiveCandidate[] = [];
  let lastFlushAt = Date.now();
  // The server log shows a run as it goes: one line per file sent (files already in
  // Drive are too many to list), every failure, a progress line each minute, and the end.
  const runStartedAt = Date.now();
  let lastProgressLogAt = runStartedAt;
  log.info(
    { files: selection.candidates.length, bytes: selection.bytesTotal },
    `[gdrive-backup] run started: ${selection.candidates.length} files, ${readableBytes(selection.bytesTotal)} selected`,
  );
  const logFailure = (path: string, error: string): void => {
    log.warn({ file: path, error }, `[gdrive-backup] failed: ${path}: ${error}`);
  };

  const flushRecord = async (): Promise<void> => {
    if (unrecorded.length === 0 || manifestFailed) return;
    try {
      record = mergeArchiveRun(record, unrecorded, new Date().toISOString());
      const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      // Drive keeps earlier revisions of a file it updates, which is the rolling
      // backup a disk archive keeps by hand.
      const written = await client.uploadBuffer(rootId, ARCHIVE_MANIFEST_FILENAME, body, 'application/json', manifestFileId);
      manifestFileId = written.id;
      unrecorded = [];
      lastFlushAt = Date.now();
    } catch (err) {
      manifestFailed = true;
      failures.push({ archiveRelPath: '(manifest)', error: message(err) });
    }
  };

  for (const candidate of selection.candidates) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const fileStartedAt = Date.now();
    try {
      const outcome = await uploadCandidate(client, tree, candidate, knownFor(candidate), signal);
      if (outcome === 'cancelled') {
        cancelled = true;
        break;
      }
      if (typeof outcome === 'object') {
        candidate.sha256 = outcome.sha256;
        unrecorded.push(candidate);
        if (outcome.copied) {
          copied++;
          bytesCopied += candidate.bytes;
          const seconds = Math.max(0.001, (Date.now() - fileStartedAt) / 1000);
          log.info(
            { file: candidate.archiveRelPath, bytes: candidate.bytes, ms: Math.round(seconds * 1000) },
            `[gdrive-backup] uploaded ${candidate.archiveRelPath} (${readableBytes(candidate.bytes)} in ${seconds.toFixed(1)} s, ${readableBytes(candidate.bytes / seconds)}/s)`,
          );
        } else {
          skipped++;
        }
      } else {
        failures.push({ archiveRelPath: candidate.archiveRelPath, error: outcome });
        logFailure(candidate.archiveRelPath, outcome);
      }
    } catch (err) {
      if (err instanceof GdriveAuthError) {
        // The sign-in is gone: every remaining file would fail the same way.
        failures.push({ archiveRelPath: '(drive)', error: err.message });
        logFailure('(drive)', err.message);
        connectionLost = true;
        break;
      }
      failures.push({ archiveRelPath: candidate.archiveRelPath, error: message(err) });
      logFailure(candidate.archiveRelPath, message(err));
    }

    filesDone++;
    bytesDone += candidate.bytes;
    report({ filesDone, bytesDone, copied, skipped });
    if (Date.now() - lastProgressLogAt >= PROGRESS_LOG_MS) {
      lastProgressLogAt = Date.now();
      log.info(
        { filesDone, filesTotal: selection.candidates.length, bytesDone, bytesTotal: selection.bytesTotal },
        `[gdrive-backup] progress: ${filesDone} of ${selection.candidates.length} files, ${readableBytes(bytesDone)} of ${readableBytes(selection.bytesTotal)}`,
      );
    }
    if (unrecorded.length >= MANIFEST_FLUSH_FILES || Date.now() - lastFlushAt >= MANIFEST_FLUSH_MS) await flushRecord();
  }

  await flushRecord();

  // The database, after the files: a run that was cancelled or lost its sign-in
  // stops here, like a disk run that lost its disk.
  const warnings = [...selection.warnings];
  if (!cancelled && !connectionLost) {
    try {
      options.takeDatabaseSnapshot?.();
    } catch (err) {
      warnings.push(`could not take a database snapshot: ${message(err)}`);
    }
    try {
      const db = await syncDatabaseBackups(client, rootId, signal);
      failures.push(...db.failures);
    } catch (err) {
      failures.push({ archiveRelPath: GDRIVE_DATABASE_FOLDER, error: message(err) });
    }
  }

  const runSeconds = Math.round((Date.now() - runStartedAt) / 1000);
  log.info(
    { copied, skipped, failures: failures.length, bytesCopied, cancelled, seconds: runSeconds },
    `[gdrive-backup] run ${cancelled ? 'cancelled' : connectionLost ? 'stopped: sign-in lost' : 'finished'} after ${runSeconds} s: ${copied} uploaded (${readableBytes(bytesCopied)}), ${skipped} already in Drive, ${failures.length} failed`,
  );

  return emptyResult({
    copied,
    skipped,
    tooYoungSkipped: selection.tooYoungSkipped,
    linkedSkipped: selection.linkedSkipped,
    cancelled,
    ...(connectionLost ? { diskLost: true } : {}),
    bytesCopied,
    failures,
    warnings,
  });
}

/**
 * Put one file in Drive, or confirm it is already there.
 *
 * Returns what to record, an error sentence, or 'cancelled'. Throws only for a lost
 * sign-in, which ends the run.
 */
async function uploadCandidate(
  client: DriveClient,
  tree: DriveTree,
  candidate: ArchiveCandidate,
  known: KnownArchivedFile | undefined,
  signal?: AbortSignal,
): Promise<{ copied: boolean; sha256: string } | string | 'cancelled'> {
  const segments = candidate.archiveRelPath.split('/');
  if (segments.some(badSegment)) return 'not a usable path in the archive';
  const fileName = segments[segments.length - 1];

  const stat = await fsp.stat(candidate.sourcePath);
  if (!stat.isFile()) return 'source is not a file';
  if (stat.size !== candidate.bytes) return `source size changed since selection (${stat.size} != ${candidate.bytes})`;

  let folderId: string;
  let remote: DriveFile | undefined;
  try {
    folderId = await tree.folderId(segments.slice(0, -1));
    remote = (await tree.listing(folderId)).files.get(fileName);
  } catch (err) {
    if (err instanceof GdriveAuthError) throw err;
    return message(err);
  }

  // Unchanged since a run verified it, and Drive still holds a file of that size.
  if (known !== undefined && stat.size === known.bytes && stat.mtimeMs === known.mtimeMs && remote?.size === known.bytes) {
    return { copied: false, sha256: known.sha256 };
  }

  // A file of the same size already in Drive may be this very file, not in the record
  // yet (an earlier run, or another install): hash it first, and send nothing if it is.
  // Any other file is going to be sent, and is hashed from the chunks the upload reads.
  let digests: { sha256: string; md5: string } | null = null;
  if (remote && remote.size === stat.size) {
    digests = await digestFile(candidate.sourcePath);
    if (remote.md5Checksum?.toLowerCase() === digests.md5) return { copied: false, sha256: digests.sha256 };
  }
  if (signal?.aborted) return 'cancelled';

  const streamed = digests === null ? new InOrderDigest() : null;
  let uploaded: DriveFile;
  try {
    uploaded = await client.uploadFile(
      folderId, fileName, candidate.sourcePath, stat.size, remote?.id, signal,
      streamed ? (start, chunk) => streamed.feed(start, chunk) : undefined,
    );
  } catch (err) {
    if (err instanceof GdriveAuthError) throw err;
    if (err instanceof DriveError && err.reason === 'cancelled') return 'cancelled';
    return message(err);
  }

  // Hashing what was sent cannot see a file that changed while it was being sent, which
  // hashing it beforehand did (the two digests then disagreed). Size and modification
  // time, before and after, catch it instead.
  const after = await fsp.stat(candidate.sourcePath).catch(() => null);
  const changedDuringUpload = after === null || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs;
  digests ??= streamed?.result(stat.size) ?? (await digestFile(candidate.sourcePath));

  if (changedDuringUpload || !uploadMatches(uploaded, stat.size, digests)) {
    // A new file that does not match is taken away again. Replacing an existing one
    // leaves Drive's previous revision available, so nothing is lost either way.
    if (!remote) {
      try {
        await client.trash(uploaded.id);
      } catch {
        // Best effort; the record does not name it, so nothing relies on it.
      }
    }
    return changedDuringUpload ? 'source changed during upload; it will be sent again next run' : 'checksum mismatch after upload';
  }
  (await tree.listing(folderId)).files.set(fileName, uploaded);
  return { copied: true, sha256: digests.sha256 };
}

// ─── Database snapshots ─────────────────────────────────────────────────────

/**
 * Upload every local database snapshot Drive does not have yet, then keep only the
 * newest `cloud` ones there. Snapshot names carry a millisecond timestamp and are
 * never rewritten, so a name of the right size in Drive is the same snapshot.
 */
export async function syncDatabaseBackups(
  client: DriveClient,
  rootId: string,
  signal?: AbortSignal,
): Promise<{ uploaded: number; pruned: number; failures: ArchiveRunResult['failures'] }> {
  const tree = new DriveTree(client, rootId);
  const folderId = await tree.folderId([GDRIVE_DATABASE_FOLDER]);
  const remote = (await tree.listing(folderId)).files;
  const failures: ArchiveRunResult['failures'] = [];
  let uploaded = 0;

  for (const backup of listDatabaseBackups()) {
    if (signal?.aborted) break;
    if (remote.get(backup.name)?.size === backup.sizeBytes) continue;
    const relPath = `${GDRIVE_DATABASE_FOLDER}/${backup.name}`;
    try {
      const digests = await digestFile(backup.path);
      const file = await client.uploadFile(folderId, backup.name, backup.path, backup.sizeBytes, remote.get(backup.name)?.id, signal);
      if (!uploadMatches(file, backup.sizeBytes, digests)) {
        if (!remote.has(backup.name)) await client.trash(file.id).catch(() => undefined);
        failures.push({ archiveRelPath: relPath, error: 'checksum mismatch after upload' });
        continue;
      }
      remote.set(backup.name, file);
      uploaded++;
    } catch (err) {
      if (err instanceof GdriveAuthError) throw err;
      failures.push({ archiveRelPath: relPath, error: message(err) });
    }
  }

  // Only our own snapshot names, and only the per-run pool. Names lead with the
  // timestamp, so a reverse sort is newest first.
  const cloud = [...remote.values()]
    .filter(f => parseBackupName(f.name)?.kind === 'cloud')
    .sort((a, b) => b.name.localeCompare(a.name));
  let pruned = 0;
  for (const stale of cloud.slice(GDRIVE_CLOUD_SNAPSHOTS_KEPT)) {
    try {
      await client.trash(stale.id);
      pruned++;
    } catch {
      // Left for the next run.
    }
  }
  return { uploaded, pruned, failures };
}

let dbUploadChain: Promise<unknown> = Promise.resolve();

/**
 * Upload the local database snapshots to Drive now, when the Drive backup is set up,
 * switched on and ours. Called after an upgrade snapshot and after a manual one.
 * Serialised, so two snapshots taken close together never upload the same file twice.
 *
 * Resolves to null when there is nothing to do (no Drive backup), and never rejects.
 */
export function uploadDatabaseBackupsToGdrive(
  config: GdriveBackupConfig,
): Promise<{ uploaded: number; failures: ArchiveRunResult['failures'] } | { error: string } | null> {
  if (!config.enabled || config.archiveId === '') return Promise.resolve(null);
  const next = dbUploadChain.then(async () => {
    const readiness = await ensureGdriveArchiveReady(config);
    if (!readiness.ok) return { error: readiness.warning };
    try {
      const result = await syncDatabaseBackups(readiness.client, readiness.folderId);
      return { uploaded: result.uploaded, failures: result.failures };
    } catch (err) {
      return { error: message(err) };
    }
  });
  dbUploadChain = next.catch(() => undefined);
  return next;
}

/**
 * Send the local database snapshots to the Google Drive backup, when there is one,
 * without holding up the request that took the snapshot. The outcome goes to the
 * system log, which is where a failed backup has to be visible.
 */
export function uploadSnapshotsToGdriveInBackground(trigger: 'manual' | 'upgrade'): void {
  void uploadDatabaseBackupsToGdrive(getGdriveBackupConfig()).then(result => {
    if (result === null) return;
    if ('error' in result) {
      logEvent({
        category: 'storage',
        event: 'db_backup_gdrive_failed',
        level: 'warning',
        message: `Could not upload the ${trigger} database backup to Google Drive: ${result.error}`,
        metadata: { trigger, error: result.error },
      });
      return;
    }
    const failed = result.failures.length;
    if (result.uploaded === 0 && failed === 0) return;
    logEvent({
      category: 'storage',
      event: 'db_backup_gdrive',
      level: failed > 0 ? 'warning' : 'info',
      message: failed > 0
        ? `Uploaded ${result.uploaded} database backup(s) to Google Drive; ${failed} failed.`
        : `Uploaded ${result.uploaded} database backup(s) to Google Drive.`,
      metadata: { trigger, uploaded: result.uploaded, failures: failed },
    });
  });
}
