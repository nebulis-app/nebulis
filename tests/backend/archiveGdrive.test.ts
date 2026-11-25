import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// Its own data folder: the runs below take real database snapshots, and they must
// not land in the shared one other suites count.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archive-gdrive-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db, { createCloudDatabaseBackup, createManualDatabaseBackup } from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { acquireLibraryLock } from '../../server/lib/libraryBusy';
import { ArchiveConfigError, DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { ARCHIVE_SETTINGS_COLUMNS } from '../../server/lib/archive/archiveColumns';
import { ARCHIVE_MANIFEST_FILENAME, parseArchiveManifestText } from '../../server/lib/archive/archiveManifest';
import {
  DEFAULT_GDRIVE_BACKUP_CONFIG,
  getGdriveBackupConfig,
  getGdriveBackupSecrets,
  setGdriveBackupConfig,
  setGdriveConnection,
} from '../../server/lib/archive/gdrive/gdriveBackupConfig';
import {
  adoptGdriveArchive,
  ensureGdriveArchiveReady,
  GDRIVE_API_DISABLED,
  GDRIVE_DEFAULT_FOLDER,
  prepareGdriveArchiveFolder,
  gdriveDestinationState,
  GDRIVE_CLOUD_SNAPSHOTS_KEPT,
  GDRIVE_DATABASE_FOLDER,
  InOrderDigest,
  runGdriveArchive,
  uploadDatabaseBackupsToGdrive,
  type GdriveRunOptions,
} from '../../server/lib/archive/gdrive/driveArchive';
import {
  getGdriveBackupProgress,
  getLastGdriveBackupRun,
  cancelGdriveBackupRun,
  resetGdriveBackupStateForTests,
  runGdriveBackup,
  tickGdriveBackupScheduler,
} from '../../server/lib/archive/gdrive/gdriveBackupRunner';
import {
  cancelGdriveSignIn,
  getGdriveSignInStatus,
  setGdriveFetchForTests,
  setGdrivePollDelayForTests,
  startGdriveSignIn,
} from '../../server/lib/archive/gdrive/driveAuth';
import { DriveClient, nextOffset, quoteDriveQuery } from '../../server/lib/archive/gdrive/driveClient';
import { FakeGoogleDrive, type FakeDriveFile } from './helpers/fakeGoogleDrive';
import { log } from '../../server/lib/logger';

/**
 * The Google Drive backup, a destination of its own next to the disk archive.
 *
 * Everything runs against `FakeGoogleDrive`, an in-memory Drive behind `fetch`, so
 * the engine is exercised end to end: sign-in, adoption, the mirrored upload with
 * checksum verification, the skip of unchanged files, the database snapshots, the
 * runner and its schedule, and the independence from the disk archive.
 */

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const FOLDER = 'Nebulis';
const seeded: string[] = [];
let drive: FakeGoogleDrive;

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seeded.push(objectId);
  setObjectLayout(objectId, 'nested');
}

function write(relPath: string, content: string | Buffer): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Signed in, with `Nebulis` at the top of My Drive as the backup folder, not adopted
 *  yet. Returns that folder. */
function configureGdrive(overrides: Record<string, unknown> = {}): FakeDriveFile {
  const folder = drive.seed('root', FOLDER, '', FOLDER_MIME);
  setGdriveBackupConfig({
    clientId: CLIENT_ID,
    clientSecret: 'client-secret',
    folderId: folder.id,
    folderPath: FOLDER,
    includeSubframes: true,
    ...overrides,
  });
  setGdriveConnection('refresh-token', 'astro@example.com');
  return folder;
}

/** Adopt the folder and switch the backup on, the way the enable route does. */
async function adopt(): Promise<void> {
  const result = await adoptGdriveArchive(getGdriveBackupConfig(), undefined);
  if (!result.ok) throw new Error(result.message);
  setGdriveBackupConfig({ archiveId: result.archiveId, enabled: true });
}

const noReport: GdriveRunOptions = { report: () => undefined };
const run = (options: Partial<GdriveRunOptions> = {}) => runGdriveArchive(getGdriveBackupConfig(), { ...noReport, ...options });

const md5 = (s: string | Buffer): string => createHash('md5').update(s).digest('hex');
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  drive = new FakeGoogleDrive();
  setGdriveFetchForTests(drive.fetch);
});

afterEach(() => {
  setGdriveFetchForTests(null);
  setGdrivePollDelayForTests(null);
  cancelGdriveSignIn();
  resetGdriveBackupStateForTests();
  resetGdriveBackupRow();
  setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG });
  for (const objectId of seeded.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_DATA_DIR, 'backups'), { recursive: true, force: true });
});

/** Every Google Drive backup column back to its default, straight from the schema. */
function resetGdriveBackupRow(): void {
  const columns = ARCHIVE_SETTINGS_COLUMNS.filter(c => c.name.startsWith('archiveGdrive'));
  const sets = columns.map(c => {
    const def = / DEFAULT (.+)$/.exec(c.ddl)?.[1] ?? "''";
    return `${c.name} = ${def}`;
  });
  db.prepare(`UPDATE appSettings SET ${sets.join(', ')} WHERE id = 1`).run();
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('configuration', () => {
  it('is off and unconfigured on a fresh install', () => {
    expect(getGdriveBackupConfig()).toEqual(DEFAULT_GDRIVE_BACKUP_CONFIG);
    expect(DEFAULT_GDRIVE_BACKUP_CONFIG).toMatchObject({ enabled: false, connected: false, folderId: '', archiveId: '', includeSubframes: false });
  });

  it('is its own setting: the disk archive has no Google Drive destination', () => {
    expect(getArchiveConfig()).not.toHaveProperty('gdrive');
    expect(() => setArchiveConfig({ locationType: 'gdrive' })).toThrow(ArchiveConfigError);
  });

  it('never returns the client secret or the sign-in, only that they exist', () => {
    configureGdrive();
    const config = getGdriveBackupConfig();
    expect(config).toMatchObject({ clientId: CLIENT_ID, hasClientSecret: true, connected: true, account: 'astro@example.com', folderPath: FOLDER });
    expect(JSON.stringify(config)).not.toContain('client-secret');
    expect(JSON.stringify(config)).not.toContain('refresh-token');
    // Sealed at rest, readable only through the secrets accessor.
    const row = db.prepare('SELECT archiveGdriveClientSecretSealed AS s, archiveGdriveRefreshTokenSealed AS r FROM appSettings WHERE id = 1').get() as { s: string; r: string };
    expect(row.s).not.toContain('client-secret');
    expect(row.r).not.toContain('refresh-token');
    expect(getGdriveBackupSecrets()).toMatchObject({ clientSecret: 'client-secret', refreshToken: 'refresh-token' });
  });

  it('refuses a client id that is not a Google OAuth client id, and My Drive itself as the folder', () => {
    expect(() => setGdriveBackupConfig({ clientId: 'not-a-client' })).toThrow(ArchiveConfigError);
    expect(() => setGdriveBackupConfig({ folderId: 'root' })).toThrow(/not My Drive itself/);
    expect(() => setGdriveBackupConfig({ folderId: 'a b/c' })).toThrow(ArchiveConfigError);
  });

  it('validates the schedule and the wait like the disk archive', () => {
    expect(() => setGdriveBackupConfig({ scheduleCron: 'not cron' })).toThrow(ArchiveConfigError);
    expect(() => setGdriveBackupConfig({ scheduleHour: 24 })).toThrow(ArchiveConfigError);
    expect(() => setGdriveBackupConfig({ copyMinAgeEnabled: true, copyMinAgeDays: 0 })).toThrow(ArchiveConfigError);
    expect(() => setGdriveBackupConfig({ nope: true })).toThrow(/unknown/);
    setGdriveBackupConfig({ scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 6, copyMinAgeEnabled: true, copyMinAgeDays: 3 });
    expect(getGdriveBackupConfig()).toMatchObject({ scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 6, copyMinAgeDays: 3 });
  });

  it('signs out and switches off when the OAuth client changes, because the old sign-in cannot be used with it', async () => {
    configureGdrive();
    await adopt();
    setGdriveBackupConfig({ clientId: 'other-client.apps.googleusercontent.com' });
    expect(getGdriveBackupConfig()).toMatchObject({ connected: false, folderId: '', archiveId: '', enabled: false });
    expect(getGdriveBackupSecrets().refreshToken).toBe('');
  });

  it('forgets the adoption and switches off when the folder changes', async () => {
    configureGdrive();
    await adopt();
    setGdriveBackupConfig({ folderId: 'another-folder' });
    expect(getGdriveBackupConfig()).toMatchObject({ archiveId: '', enabled: false });
  });
});

describe('sign-in (device code)', () => {
  it('shows the code, then stores the sign-in once Google answers', async () => {
    setGdriveBackupConfig({ clientId: CLIENT_ID, clientSecret: 'client-secret' });
    setGdrivePollDelayForTests(1);
    drive.devicePollAnswers = [
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'access-token', refresh_token: 'new-refresh', expires_in: 3600 } },
    ];
    const started = await startGdriveSignIn();
    expect(started).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device' });

    await vi.waitFor(() => expect(getGdriveSignInStatus().state).toBe('connected'));
    expect(getGdriveSignInStatus().account).toBe('astro@example.com');
    expect(getGdriveBackupSecrets().refreshToken).toBe('new-refresh');
  });

  it('reports a declined consent and stores nothing', async () => {
    setGdriveBackupConfig({ clientId: CLIENT_ID, clientSecret: 'client-secret' });
    setGdrivePollDelayForTests(1);
    drive.devicePollAnswers = [{ status: 403, body: { error: 'access_denied' } }];
    await startGdriveSignIn();
    await vi.waitFor(() => expect(getGdriveSignInStatus().state).toBe('denied'));
    expect(getGdriveBackupSecrets().refreshToken).toBe('');
  });

  it('refuses to start without a client', async () => {
    await expect(startGdriveSignIn()).rejects.toThrow(/client id/);
  });

  it('forgets a sign-in Google has revoked', async () => {
    configureGdrive();
    drive.revoked = true;
    const ready = await ensureGdriveArchiveReady(getGdriveBackupConfig());
    expect(ready.ok).toBe(false);
    expect(getGdriveBackupConfig().connected).toBe(false);
  });
});

describe('adopting the folder', () => {
  it('reports a chosen folder without a marker as absent, and adopting writes ours', async () => {
    configureGdrive();
    expect((await gdriveDestinationState(getGdriveBackupConfig())).state).toBe('absent');
    await adopt();
    const tree = drive.tree(FOLDER);
    expect(tree.has('.nebulisarchive')).toBe(true);
    expect(JSON.parse(tree.get('.nebulisarchive')!.content.toString()).archiveId).toBe(getGdriveBackupConfig().archiveId);
    expect((await gdriveDestinationState(getGdriveBackupConfig())).state).toBe('match');
  });

  it('is offline, not absent, when nobody is signed in', async () => {
    expect((await gdriveDestinationState(getGdriveBackupConfig())).state).toBe('offline');
  });

  it('is offline when the chosen folder has gone to the bin, and adopting does not recreate it', async () => {
    const folder = configureGdrive();
    folder.trashed = true;
    expect((await gdriveDestinationState(getGdriveBackupConfig())).state).toBe('offline');
    expect(await adoptGdriveArchive(getGdriveBackupConfig(), undefined)).toMatchObject({ ok: false });
    expect([...drive.files.values()].filter(f => f.name === FOLDER && !f.trashed)).toHaveLength(0);
  });

  it('follows the folder by id after the user moves and renames it in Drive', async () => {
    const folder = configureGdrive();
    await adopt();
    const astro = drive.seed('root', 'Astro', '', FOLDER_MIME);
    folder.parents = [astro.id];
    folder.name = 'Backups';
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'moved');
    const result = await run();
    expect(result.failures).toEqual([]);
    expect(drive.tree('Astro').get('Backups/M 42/processed/final.jpg')?.content.toString()).toBe('moved');
  });

  it('will not take over another install’s folder without its id, and sets its record aside when confirmed', async () => {
    const folder = configureGdrive();
    drive.seed(folder.id, '.nebulisarchive', JSON.stringify({ archiveId: 'someone-else' }));
    drive.seed(folder.id, ARCHIVE_MANIFEST_FILENAME, '{"version":2,"updatedAt":"","objects":{}}');

    const refused = await adoptGdriveArchive(getGdriveBackupConfig(), undefined);
    expect(refused).toMatchObject({ ok: false, code: 'GDRIVE_FOREIGN_CONFIRMATION_REQUIRED' });

    const taken = await adoptGdriveArchive(getGdriveBackupConfig(), 'someone-else');
    expect(taken).toMatchObject({ ok: true, replacedArchiveId: 'someone-else', previousRecordSetAside: true });
    expect(drive.tree(FOLDER).has(`${ARCHIVE_MANIFEST_FILENAME}.previous`)).toBe(true);
    expect(drive.tree(FOLDER).has(ARCHIVE_MANIFEST_FILENAME)).toBe(false);
  });

  it('never overwrites a marker it cannot read', async () => {
    const folder = configureGdrive();
    drive.seed(folder.id, '.nebulisarchive', 'not json');
    expect(await adoptGdriveArchive(getGdriveBackupConfig(), undefined)).toMatchObject({ ok: false, code: 'GDRIVE_MARKER_UNREADABLE' });
  });
});

describe('the backup folder after sign-in', () => {
  function signIn(): void {
    setGdriveBackupConfig({ clientId: CLIENT_ID, clientSecret: 'client-secret' });
    setGdriveConnection('refresh-token', 'astro@example.com');
  }
  const liveNebulisFolders = () => [...drive.files.values()].filter(f => f.name === GDRIVE_DEFAULT_FOLDER && !f.trashed);

  it('creates a Nebulis folder at the top of My Drive once, then reuses it', async () => {
    signIn();
    const first = await prepareGdriveArchiveFolder();
    expect(first).toMatchObject({ created: true, folder: { name: GDRIVE_DEFAULT_FOLDER } });
    expect(drive.files.get(first.folder.id)).toMatchObject({ parents: ['root'], mimeType: FOLDER_MIME });
    // Not saved yet (the page saves it next): still found, not made twice.
    const again = await prepareGdriveArchiveFolder();
    expect(again).toEqual({ created: false, folder: first.folder });
    expect(liveNebulisFolders()).toHaveLength(1);
  });

  it('keeps the chosen folder, wherever it was moved and whatever it is now called', async () => {
    const folder = configureGdrive();
    const astro = drive.seed('root', 'Astro', '', FOLDER_MIME);
    folder.parents = [astro.id];
    folder.name = 'Backups';
    expect(await prepareGdriveArchiveFolder()).toEqual({ created: false, folder: { id: folder.id, name: 'Backups' } });
    expect(liveNebulisFolders()).toHaveLength(0);
  });

  it('makes a new one when the chosen folder went to the bin', async () => {
    const folder = configureGdrive();
    folder.trashed = true;
    const next = await prepareGdriveArchiveFolder();
    expect(next.created).toBe(true);
    expect(next.folder.id).not.toBe(folder.id);
  });

  it('needs a sign-in', async () => {
    await expect(prepareGdriveArchiveFolder()).rejects.toMatchObject({ code: 'GDRIVE_NOT_CONNECTED' });
  });

  it('says the Drive API is off instead of failing vaguely', async () => {
    configureGdrive();
    drive.apiDisabled = true;
    await expect(prepareGdriveArchiveFolder()).rejects.toMatchObject({ code: 'GDRIVE_API_DISABLED', message: GDRIVE_API_DISABLED });
    const ready = await ensureGdriveArchiveReady(getGdriveBackupConfig());
    expect(ready).toMatchObject({ ok: false, warning: GDRIVE_API_DISABLED });
  });
});

describe('a run', () => {
  function seedLibrary(): void {
    seedObject('M31', 'M 31');
    write('M 31/2024-10-08_22-00-00/sub_00001_M31_10.0s_LP_20241008-220000.fit', 'sub frame');
    write('M 31/2024-10-08_22-00-00/Stacked_10_M31_10.0s_LP_20241008-220000.jpg', 'stacked');
    // The gallery's finished images.
    write('M 31/processed/final.jpg', 'final image');
    write('M 31/processed/2024/variant.tif', 'variant');
    write('_archive/tele-1/CALI_FRAME/cali_001.fits', 'dark');
  }

  it('refuses to write to a folder that is not adopted', async () => {
    configureGdrive();
    seedLibrary();
    const result = await run();
    expect(result).toMatchObject({ ran: false, reason: 'destination-unusable' });
    expect(drive.uploads).toBe(0);
  });

  it('mirrors the library, gallery included, verifies every file, and records it', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();

    const result = await run();
    expect(result.failures).toEqual([]);
    expect(result.copied).toBe(5);

    const tree = drive.tree(FOLDER);
    expect(tree.get('M 31/processed/final.jpg')?.content.toString()).toBe('final image');
    expect(tree.get('M 31/processed/2024/variant.tif')?.content.toString()).toBe('variant');
    expect(tree.get('M 31/2024-10-08_22-00-00/sub_00001_M31_10.0s_LP_20241008-220000.fit')?.content.toString()).toBe('sub frame');
    expect(tree.get('_archive/tele-1/CALI_FRAME/cali_001.fits')?.content.toString()).toBe('dark');

    const manifest = parseArchiveManifestText(tree.get(ARCHIVE_MANIFEST_FILENAME)!.content.toString());
    expect(manifest?.archiveId).toBe(getGdriveBackupConfig().archiveId);
    expect(manifest?.objects['M 31'].files.map(f => f.relPath)).toContain('processed/final.jpg');
  });

  it('skips unchanged files on the next run without uploading them again, and sends a changed one', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    await run();
    const uploadsAfterFirst = drive.uploads;

    const second = await run();
    expect(second).toMatchObject({ copied: 0, skipped: 5 });
    // Only the record is written again (it is unchanged in content, but re-stamped).
    expect(drive.uploads - uploadsAfterFirst).toBeLessThanOrEqual(1);

    write('M 31/processed/final.jpg', 'final image, reprocessed');
    const third = await run();
    expect(third).toMatchObject({ copied: 1, skipped: 4 });
    expect(drive.tree(FOLDER).get('M 31/processed/final.jpg')?.content.toString()).toBe('final image, reprocessed');
  });

  it('adopts a file that is already in Drive with the same content instead of uploading it', async () => {
    configureGdrive();
    await adopt();
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'same bytes');
    const folder = [...drive.files.values()].find(f => f.name === FOLDER)!;
    const objectFolder = drive.seed(folder.id, 'M 42', '', 'application/vnd.google-apps.folder');
    const processed = drive.seed(objectFolder.id, 'processed', '', 'application/vnd.google-apps.folder');
    drive.seed(processed.id, 'final.jpg', 'same bytes');
    const before = drive.uploads;

    const result = await run();
    expect(result).toMatchObject({ copied: 0, skipped: 1 });
    // The record, and nothing else.
    expect(drive.uploads - before).toBe(1);
  });

  it('does not record a file whose checksum Drive reports differently, and takes the new upload away', async () => {
    configureGdrive();
    await adopt();
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'payload');
    drive.corruptNextUploads = 1;

    const result = await run();
    expect(result.failures).toEqual([{ archiveRelPath: 'M 42/processed/final.jpg', error: 'checksum mismatch after upload' }]);
    expect(drive.tree(FOLDER).has('M 42/processed/final.jpg')).toBe(false);
    const manifestFile = drive.tree(FOLDER).get(ARCHIVE_MANIFEST_FILENAME);
    const manifest = manifestFile ? parseArchiveManifestText(manifestFile.content.toString()) : null;
    expect(manifest?.objects['M 42']).toBeUndefined();
  });

  it('reads a new file once: it is hashed from the chunks it is sent in', async () => {
    configureGdrive();
    await adopt();
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'payload sent once');
    const streams = vi.spyOn(fs, 'createReadStream');
    let hashedSeparately: boolean;
    try {
      const result = await run();
      expect(result).toMatchObject({ copied: 1, failures: [] });
      hashedSeparately = streams.mock.calls.some(call => String(call[0]).endsWith('final.jpg'));
    } finally {
      streams.mockRestore();
    }
    expect(hashedSeparately).toBe(false);
    expect(drive.tree(FOLDER).get('M 42/processed/final.jpg')?.content.toString()).toBe('payload sent once');
  });

  it('does not record a file that changed while it was being sent, and takes the upload away', async () => {
    configureGdrive();
    await adopt();
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'payload');
    const source = path.join(getLibraryDir(), 'M 42/processed/final.jpg');
    // The file is touched while its bytes are on the way.
    setGdriveFetchForTests(async (input, init) => {
      if (init?.method === 'PUT') {
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(source, later, later);
      }
      return drive.fetch(input, init);
    });

    const result = await run();
    expect(result.failures).toEqual([
      { archiveRelPath: 'M 42/processed/final.jpg', error: 'source changed during upload; it will be sent again next run' },
    ]);
    expect(drive.tree(FOLDER).has('M 42/processed/final.jpg')).toBe(false);
  });

  it('refuses when the Drive quota cannot hold what is left to send', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    drive.quota = { limit: 10, usage: 8 };
    const result = await run();
    expect(result).toMatchObject({ ran: false, reason: 'insufficient-space' });
  });

  it('never replaces a record it cannot read', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    const folder = [...drive.files.values()].find(f => f.name === FOLDER)!;
    drive.seed(folder.id, ARCHIVE_MANIFEST_FILENAME, 'truncated{');
    const result = await run();
    expect(result.failures[0].archiveRelPath).toBe('(manifest)');
    expect(drive.tree(FOLDER).get(ARCHIVE_MANIFEST_FILENAME)?.content.toString()).toBe('truncated{');
  });
});

describe('the Nebulis database', () => {
  it('each run takes a snapshot and uploads every local snapshot Drive does not have', async () => {
    configureGdrive();
    await adopt();
    createManualDatabaseBackup();

    const result = await run({ takeDatabaseSnapshot: () => void createCloudDatabaseBackup() });
    expect(result.failures).toEqual([]);

    const names = [...drive.tree(FOLDER).keys()].filter(k => k.startsWith(`${GDRIVE_DATABASE_FOLDER}/`));
    expect(names.some(n => n.endsWith('-manual.db'))).toBe(true);
    expect(names.some(n => n.endsWith('-cloud.db'))).toBe(true);
    // A real, verified copy of the snapshot.
    const local = fs.readdirSync(path.join(TEST_DATA_DIR, 'backups')).find(n => n.endsWith('-manual.db'))!;
    const remote = drive.tree(FOLDER).get(`${GDRIVE_DATABASE_FOLDER}/${local}`)!;
    expect(md5(remote.content)).toBe(md5(fs.readFileSync(path.join(TEST_DATA_DIR, 'backups', local))));
  });

  it('uploads a manual snapshot on its own when the Drive backup is on, and does nothing otherwise', async () => {
    configureGdrive();
    await adopt();
    createManualDatabaseBackup();
    const result = await uploadDatabaseBackupsToGdrive(getGdriveBackupConfig());
    expect(result).toMatchObject({ uploaded: 1, failures: [] });
    // Already there: nothing more to send.
    expect(await uploadDatabaseBackupsToGdrive(getGdriveBackupConfig())).toMatchObject({ uploaded: 0 });

    setGdriveBackupConfig({ enabled: false });
    expect(await uploadDatabaseBackupsToGdrive(getGdriveBackupConfig())).toBeNull();
  });

  it(`keeps only the newest ${GDRIVE_CLOUD_SNAPSHOTS_KEPT} per-run snapshots in Drive, and never touches the others`, async () => {
    configureGdrive();
    await adopt();
    const folder = [...drive.files.values()].find(f => f.name === FOLDER)!;
    const dbFolder = drive.seed(folder.id, GDRIVE_DATABASE_FOLDER, '', 'application/vnd.google-apps.folder');
    for (let i = 0; i < GDRIVE_CLOUD_SNAPSHOTS_KEPT + 3; i++) {
      const ts = `202601${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}0000.000Z`;
      drive.seed(dbFolder.id, `nebulis-db-${ts}-v2.2.3-cloud.db`, 'x');
    }
    drive.seed(dbFolder.id, 'nebulis-db-20200101T000000.000Z-v1.0.0-upgrade.db', 'old upgrade');
    drive.seed(dbFolder.id, 'notes.txt', 'the user put this here');

    await uploadDatabaseBackupsToGdrive(getGdriveBackupConfig());
    const remaining = [...drive.tree(FOLDER).keys()].filter(k => k.startsWith(`${GDRIVE_DATABASE_FOLDER}/`));
    expect(remaining.filter(n => n.endsWith('-cloud.db'))).toHaveLength(GDRIVE_CLOUD_SNAPSHOTS_KEPT);
    expect(remaining).toContain(`${GDRIVE_DATABASE_FOLDER}/nebulis-db-20200101T000000.000Z-v1.0.0-upgrade.db`);
    expect(remaining).toContain(`${GDRIVE_DATABASE_FOLDER}/notes.txt`);
    // Into the bin, not gone.
    expect([...drive.files.values()].filter(f => f.trashed)).toHaveLength(3);
  });
});

describe('the runner and its schedule', () => {
  function seedOne(): void {
    seedObject('M42', 'M 42');
    write('M 42/processed/final.jpg', 'final');
  }

  it('runs, records the result and the run instant, and reports progress', async () => {
    configureGdrive();
    await adopt();
    seedOne();
    const now = new Date('2026-03-01T03:00:00Z');
    const info = vi.spyOn(log, 'info');
    const result = await runGdriveBackup(getGdriveBackupConfig(), now, 'manual');
    expect(result).toMatchObject({ ran: true, copied: 1, failures: [] });
    // The server log follows the run: its start, each file sent, and its end.
    const lines = info.mock.calls.map(call => String(call[1] ?? call[0]));
    info.mockRestore();
    expect(lines.some(l => l.startsWith('[gdrive-backup] run started: 1 files'))).toBe(true);
    expect(lines.some(l => l.startsWith('[gdrive-backup] uploaded M 42/processed/final.jpg ('))).toBe(true);
    expect(lines.some(l => /^\[gdrive-backup\] run finished after \d+ s: 1 uploaded/.test(l))).toBe(true);
    expect(getGdriveBackupConfig()).toMatchObject({ lastRunAt: now.toISOString(), lastResult: '1 uploaded, 0 already in Drive' });
    expect(getGdriveBackupProgress()).toMatchObject({ running: false, phase: 'done', filesDone: 1, filesTotal: 1 });
    expect(getLastGdriveBackupRun()).toMatchObject({ trigger: 'manual', result: { summary: '1 uploaded, 0 already in Drive' } });
    // A complete run is also the last attempt, and the run record gives both ends in one format.
    expect(getGdriveBackupConfig().lastAttemptAt).toBe(now.toISOString());
    const last = getLastGdriveBackupRun()!;
    expect(last.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(last.finishedAt)).toBeGreaterThanOrEqual(Date.parse(last.startedAt));
    // The database went too.
    expect([...drive.tree(FOLDER).keys()].some(k => k.startsWith(`${GDRIVE_DATABASE_FOLDER}/`) && k.endsWith('-cloud.db'))).toBe(true);
  });

  it('dates a cancelled attempt on its own, and leaves the last complete run as it was', async () => {
    configureGdrive();
    await adopt();
    seedOne();
    const first = new Date('2026-03-01T03:00:00Z');
    await runGdriveBackup(getGdriveBackupConfig(), first, 'manual');

    write('M 42/processed/second.jpg', 'second');
    const later = new Date('2026-03-02T03:00:00Z');
    const pending = runGdriveBackup(getGdriveBackupConfig(), later, 'manual');
    expect(cancelGdriveBackupRun()).toBe(true);
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(getGdriveBackupConfig()).toMatchObject({
      // Still the complete run: the schedule must keep counting from it.
      lastRunAt: first.toISOString(),
      // The attempt, with its own date and result.
      lastAttemptAt: later.toISOString(),
      lastResult: expect.stringMatching(/^cancelled: /),
    });
  });

  it('runs while the disk archive holds the library lock: the two are independent', async () => {
    configureGdrive();
    await adopt();
    seedOne();
    const release = acquireLibraryLock('archive');
    expect(release).not.toBeNull();
    try {
      const result = await runGdriveBackup(getGdriveBackupConfig(), new Date(), 'manual');
      expect(result).toMatchObject({ ran: true, copied: 1 });
    } finally {
      release?.();
    }
  });

  it('does not start on schedule while library files are being moved or deleted', async () => {
    configureGdrive({ scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 1 });
    await adopt();
    const release = acquireLibraryLock('purge');
    try {
      expect(await tickGdriveBackupScheduler(new Date(), 'UTC')).toEqual({ ran: false, skippedBecause: 'library-busy' });
    } finally {
      release?.();
    }
  });

  it('fires when due, not before, and never while off', async () => {
    configureGdrive({ scheduleEnabled: true, scheduleMode: 'daily', scheduleHour: 3, scheduleMinute: 0 });
    await adopt();
    seedOne();
    expect(await tickGdriveBackupScheduler(new Date('2026-03-01T02:59:00Z'), 'UTC')).toEqual({ ran: false, skippedBecause: 'not-due' });
    expect(await tickGdriveBackupScheduler(new Date('2026-03-01T03:00:00Z'), 'UTC')).toEqual({ ran: true, skippedBecause: null });
    // Once a day.
    expect(await tickGdriveBackupScheduler(new Date('2026-03-01T09:00:00Z'), 'UTC')).toEqual({ ran: false, skippedBecause: 'not-due' });

    setGdriveBackupConfig({ enabled: false });
    expect(await tickGdriveBackupScheduler(new Date('2026-03-02T03:00:00Z'), 'UTC')).toEqual({ ran: false, skippedBecause: 'disabled' });
  });

  it('backs off after a refusal and says why', async () => {
    configureGdrive({ scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 1 });
    await adopt();
    seedOne();
    drive.apiDisabled = true;
    const now = new Date('2026-03-01T03:00:00Z');
    expect(await tickGdriveBackupScheduler(now, 'UTC')).toEqual({ ran: false, skippedBecause: 'refused' });
    expect(getGdriveBackupConfig().lastResult).toBe(`skipped: ${GDRIVE_API_DISABLED}`);
    const callsAfterRefusal = drive.requests;
    // A minute later the backoff holds, and Drive is not asked again.
    expect(await tickGdriveBackupScheduler(new Date(now.getTime() + 60_000), 'UTC')).toEqual({ ran: false, skippedBecause: 'refused' });
    expect(drive.requests).toBe(callsAfterRefusal);
  });
});

describe('Drive client', () => {
  function client(fetchImpl: typeof fetch, chunkBytes = 4): DriveClient {
    return new DriveClient({ getAccessToken: async () => 'access-token', fetch: fetchImpl, backoffMs: () => 0, chunkBytes });
  }

  it('hashes the chunks an upload reads, each byte once and in order, across a resume', () => {
    const bytes = Buffer.from('abcdefghijklmnopqrstuvwxy');
    const digest = new InOrderDigest();
    digest.feed(0, bytes.subarray(0, 10));
    digest.feed(10, bytes.subarray(10, 20));
    // Drive kept only 15 bytes: the upload resumes there and reads 15–20 again.
    digest.feed(15, bytes.subarray(15, 20));
    digest.feed(20, bytes.subarray(20, 25));
    expect(digest.result(bytes.length)).toEqual({ sha256: sha256(bytes), md5: md5(bytes) });

    // A gap means the chunks did not cover the file: no digest, so the caller hashes it.
    const gap = new InOrderDigest();
    gap.feed(0, bytes.subarray(0, 5));
    gap.feed(10, bytes.subarray(10, 25));
    expect(gap.result(bytes.length)).toBeNull();
  });

  it('reads the resume offset from a 308', () => {
    expect(nextOffset(null)).toBe(0);
    expect(nextOffset('bytes=0-1023')).toBe(1024);
  });

  it('quotes names for a search', () => {
    expect(quoteDriveQuery("Bob's \\ folder")).toBe("'Bob\\'s \\\\ folder'");
  });

  it('uploads in chunks and resumes from Drive’s offset after a failed chunk', async () => {
    const parent = drive.seed('root', 'p', '', 'application/vnd.google-apps.folder');
    const source = path.join(TEST_DATA_DIR, 'chunked.bin');
    fs.writeFileSync(source, 'abcdefghijklmnopq');
    drive.failNextChunks = 1;
    const file = await client(drive.fetch).uploadFile(parent.id, 'chunked.bin', source, 17);
    expect(drive.files.get(file.id)?.content.toString()).toBe('abcdefghijklmnopq');
    expect(file.md5Checksum).toBe(md5('abcdefghijklmnopq'));
    // 5 chunks of 4 bytes, plus the failed one.
    expect(drive.chunkPuts).toBe(6);
  });

  it('retries a rate-limited call, and gets a fresh token once on a 401', async () => {
    let calls = 0;
    let invalidated = 0;
    const fake: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'slow', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403 });
      if (calls === 2) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ user: { emailAddress: 'a@b' }, storageQuota: { usage: '0' } }), { status: 200 });
    };
    const c = new DriveClient({ getAccessToken: async () => 't', invalidateAccessToken: () => invalidated++, fetch: fake, backoffMs: () => 0 });
    expect((await c.about()).email).toBe('a@b');
    expect(calls).toBe(3);
    expect(invalidated).toBe(1);
  });

  it('does not retry a plain permission error', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'no', errors: [{ reason: 'insufficientFilePermissions' }] } }), { status: 403 });
    };
    await expect(client(fake).about()).rejects.toThrow('no');
    expect(calls).toBe(1);
  });
});
