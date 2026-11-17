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
import {
  DEFAULT_ARCHIVE_CONFIG,
  ArchiveConfigError,
  getArchiveConfig,
  getArchiveGdriveSecrets,
  setArchiveConfig,
  setArchiveGdriveConnection,
} from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { resolveArchiveDestination } from '../../server/lib/archive/archiveDestination';
import { listArchivedObjects } from '../../server/lib/archive/archiveBrowse';
import { ARCHIVE_MANIFEST_FILENAME, parseArchiveManifestText } from '../../server/lib/archive/archiveManifest';
import {
  adoptGdriveArchive,
  ensureGdriveArchiveReady,
  gdriveDestinationState,
  GDRIVE_CLOUD_SNAPSHOTS_KEPT,
  GDRIVE_DATABASE_FOLDER,
  uploadDatabaseBackupsToGdrive,
} from '../../server/lib/archive/gdrive/driveArchive';
import {
  cancelGdriveSignIn,
  getGdriveSignInStatus,
  setGdriveFetchForTests,
  setGdrivePollDelayForTests,
  startGdriveSignIn,
} from '../../server/lib/archive/gdrive/driveAuth';
import { DriveClient, nextOffset, quoteDriveQuery } from '../../server/lib/archive/gdrive/driveClient';
import { FakeGoogleDrive } from './helpers/fakeGoogleDrive';

/**
 * The archive, with a Google Drive folder as its destination.
 *
 * Everything runs against `FakeGoogleDrive`, an in-memory Drive behind `fetch`, so
 * the engine is exercised end to end: sign-in, adoption, the mirrored upload with
 * checksum verification, the skip of unchanged files, the database snapshots, and
 * the refusals that keep the filesystem-only steps away from a Drive folder.
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

/** A Drive archive, signed in, not adopted yet. */
function configureGdrive(overrides: Record<string, unknown> = {}): void {
  setArchiveConfig({
    enabled: true,
    locationType: 'gdrive',
    scope: 'all',
    includeSubframes: true,
    gdrive: { clientId: CLIENT_ID, clientSecret: 'client-secret', folderName: FOLDER },
    ...overrides,
  });
  setArchiveGdriveConnection('refresh-token', 'astro@example.com');
}

async function adopt(): Promise<void> {
  const result = await adoptGdriveArchive(getArchiveConfig(), undefined);
  if (!result.ok) throw new Error(result.message);
  setArchiveConfig({ archiveId: result.archiveId });
}

const md5 = (s: string | Buffer): string => createHash('md5').update(s).digest('hex');

beforeEach(() => {
  drive = new FakeGoogleDrive();
  setGdriveFetchForTests(drive.fetch);
});

afterEach(() => {
  setGdriveFetchForTests(null);
  setGdrivePollDelayForTests(null);
  cancelGdriveSignIn();
  setArchiveConfig({
    ...DEFAULT_ARCHIVE_CONFIG,
    gdrive: { clientId: '', clearClientSecret: true, folderName: FOLDER },
  });
  setArchiveGdriveConnection('', '');
  for (const objectId of seeded.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_DATA_DIR, 'backups'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('configuration', () => {
  it('is off and unconfigured on a fresh install', () => {
    expect(DEFAULT_ARCHIVE_CONFIG.gdrive).toEqual({
      clientId: '',
      hasClientSecret: false,
      connected: false,
      account: '',
      folderName: 'Nebulis',
    });
  });

  it('never returns the client secret or the sign-in, only that they exist', () => {
    configureGdrive();
    const config = getArchiveConfig();
    expect(config.locationType).toBe('gdrive');
    expect(config.gdrive).toEqual({ clientId: CLIENT_ID, hasClientSecret: true, connected: true, account: 'astro@example.com', folderName: FOLDER });
    expect(JSON.stringify(config)).not.toContain('client-secret');
    expect(JSON.stringify(config)).not.toContain('refresh-token');
    // Sealed at rest, readable only through the secrets accessor.
    const row = db.prepare('SELECT archiveGdriveClientSecretSealed AS s, archiveGdriveRefreshTokenSealed AS r FROM appSettings WHERE id = 1').get() as { s: string; r: string };
    expect(row.s).not.toContain('client-secret');
    expect(row.r).not.toContain('refresh-token');
    expect(getArchiveGdriveSecrets()).toMatchObject({ clientSecret: 'client-secret', refreshToken: 'refresh-token' });
  });

  it('refuses a client id that is not a Google OAuth client id', () => {
    expect(() => setArchiveConfig({ gdrive: { clientId: 'not-a-client' } })).toThrow(ArchiveConfigError);
  });

  it('refuses a folder name that reads as a path', () => {
    for (const name of ['a/b', '..', '', '  ']) {
      expect(() => setArchiveConfig({ gdrive: { folderName: name } }), name).toThrow(ArchiveConfigError);
    }
  });

  it('signs out when the OAuth client changes, because the old sign-in cannot be used with it', () => {
    configureGdrive();
    setArchiveConfig({ gdrive: { clientId: 'other-client.apps.googleusercontent.com' } });
    expect(getArchiveConfig().gdrive.connected).toBe(false);
    expect(getArchiveGdriveSecrets().refreshToken).toBe('');
  });

  it('refuses pruning and local removal for a Drive archive, in either order', () => {
    configureGdrive();
    expect(() => setArchiveConfig({ retentionDays: 30, retentionEnabled: true })).toThrow(/Google Drive/);
    expect(() => setArchiveConfig({ removeLocalAfter: true })).toThrow(/Google Drive/);

    setArchiveConfig({ locationType: 'local', removeLocalAfter: true });
    expect(() => setArchiveConfig({ locationType: 'gdrive' })).toThrow(/Google Drive/);
    expect(getArchiveConfig().locationType).toBe('local');
  });

  it('keeps every filesystem-only step away from a Drive folder', async () => {
    configureGdrive();
    await adopt();
    const resolved = resolveArchiveDestination(getArchiveConfig());
    expect(resolved.ok).toBe(false);
    // Browsing goes through the filesystem resolver and must refuse rather than read
    // some local path.
    const listing = await listArchivedObjects(getArchiveConfig());
    expect(listing.objects).toEqual([]);
    expect(listing.warnings[0]).toMatch(/Google Drive/);
  });
});

describe('sign-in (device code)', () => {
  it('shows the code, then stores the sign-in once Google answers', async () => {
    setArchiveConfig({ gdrive: { clientId: CLIENT_ID, clientSecret: 'client-secret' } });
    setGdrivePollDelayForTests(1);
    drive.devicePollAnswers = [
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'access-token', refresh_token: 'new-refresh', expires_in: 3600 } },
    ];
    const started = await startGdriveSignIn();
    expect(started).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device' });

    await vi.waitFor(() => expect(getGdriveSignInStatus().state).toBe('connected'));
    expect(getGdriveSignInStatus().account).toBe('astro@example.com');
    expect(getArchiveGdriveSecrets().refreshToken).toBe('new-refresh');
  });

  it('reports a declined consent and stores nothing', async () => {
    setArchiveConfig({ gdrive: { clientId: CLIENT_ID, clientSecret: 'client-secret' } });
    setGdrivePollDelayForTests(1);
    drive.devicePollAnswers = [{ status: 403, body: { error: 'access_denied' } }];
    await startGdriveSignIn();
    await vi.waitFor(() => expect(getGdriveSignInStatus().state).toBe('denied'));
    expect(getArchiveGdriveSecrets().refreshToken).toBe('');
  });

  it('refuses to start without a client', async () => {
    await expect(startGdriveSignIn()).rejects.toThrow(/client id/);
  });

  it('forgets a sign-in Google has revoked', async () => {
    configureGdrive();
    drive.revoked = true;
    const ready = await ensureGdriveArchiveReady(getArchiveConfig());
    expect(ready.ok).toBe(false);
    expect(getArchiveConfig().gdrive.connected).toBe(false);
  });
});

describe('adopting the folder', () => {
  it('reports a folder that does not exist yet as absent, and adopting creates it with our marker', async () => {
    configureGdrive();
    expect((await gdriveDestinationState(getArchiveConfig())).state).toBe('absent');
    await adopt();
    const tree = drive.tree(FOLDER);
    expect(tree.has('.nebulisarchive')).toBe(true);
    expect(JSON.parse(tree.get('.nebulisarchive')!.content.toString()).archiveId).toBe(getArchiveConfig().archiveId);
    expect((await gdriveDestinationState(getArchiveConfig())).state).toBe('match');
  });

  it('is offline, not absent, when nobody is signed in', async () => {
    setArchiveConfig({ enabled: true, locationType: 'gdrive' });
    expect((await gdriveDestinationState(getArchiveConfig())).state).toBe('offline');
  });

  it('will not take over another install’s folder without its id, and sets its record aside when confirmed', async () => {
    configureGdrive();
    const folder = drive.seed('root', FOLDER, '', 'application/vnd.google-apps.folder');
    drive.seed(folder.id, '.nebulisarchive', JSON.stringify({ archiveId: 'someone-else' }));
    drive.seed(folder.id, ARCHIVE_MANIFEST_FILENAME, '{"version":2,"updatedAt":"","objects":{}}');

    const refused = await adoptGdriveArchive(getArchiveConfig(), undefined);
    expect(refused).toMatchObject({ ok: false, code: 'ARCHIVE_FOREIGN_CONFIRMATION_REQUIRED' });

    const taken = await adoptGdriveArchive(getArchiveConfig(), 'someone-else');
    expect(taken).toMatchObject({ ok: true, replacedArchiveId: 'someone-else', previousRecordSetAside: true });
    expect(drive.tree(FOLDER).has(`${ARCHIVE_MANIFEST_FILENAME}.previous`)).toBe(true);
    expect(drive.tree(FOLDER).has(ARCHIVE_MANIFEST_FILENAME)).toBe(false);
  });

  it('never overwrites a marker it cannot read', async () => {
    configureGdrive();
    const folder = drive.seed('root', FOLDER, '', 'application/vnd.google-apps.folder');
    drive.seed(folder.id, '.nebulisarchive', 'not json');
    expect(await adoptGdriveArchive(getArchiveConfig(), undefined)).toMatchObject({ ok: false, code: 'ARCHIVE_MARKER_UNREADABLE' });
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
    const result = await runArchive(getArchiveConfig());
    expect(result).toMatchObject({ ran: false, reason: 'destination-unusable' });
    expect(drive.uploads).toBe(0);
  });

  it('mirrors the library, gallery included, verifies every file, and records it', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();

    const result = await runArchive(getArchiveConfig());
    expect(result.failures).toEqual([]);
    expect(result.copied).toBe(5);

    const tree = drive.tree(FOLDER);
    expect(tree.get('M 31/processed/final.jpg')?.content.toString()).toBe('final image');
    expect(tree.get('M 31/processed/2024/variant.tif')?.content.toString()).toBe('variant');
    expect(tree.get('M 31/2024-10-08_22-00-00/sub_00001_M31_10.0s_LP_20241008-220000.fit')?.content.toString()).toBe('sub frame');
    expect(tree.get('_archive/tele-1/CALI_FRAME/cali_001.fits')?.content.toString()).toBe('dark');

    const manifest = parseArchiveManifestText(tree.get(ARCHIVE_MANIFEST_FILENAME)!.content.toString());
    expect(manifest?.archiveId).toBe(getArchiveConfig().archiveId);
    expect(manifest?.objects['M 31'].files.map(f => f.relPath)).toContain('processed/final.jpg');
  });

  it('skips unchanged files on the next run without uploading them again, and sends a changed one', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    await runArchive(getArchiveConfig());
    const uploadsAfterFirst = drive.uploads;

    const second = await runArchive(getArchiveConfig());
    expect(second).toMatchObject({ copied: 0, skipped: 5 });
    // Only the record is written again (it is unchanged in content, but re-stamped).
    expect(drive.uploads - uploadsAfterFirst).toBeLessThanOrEqual(1);

    write('M 31/processed/final.jpg', 'final image, reprocessed');
    const third = await runArchive(getArchiveConfig());
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

    const result = await runArchive(getArchiveConfig());
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

    const result = await runArchive(getArchiveConfig());
    expect(result.failures).toEqual([{ archiveRelPath: 'M 42/processed/final.jpg', error: 'checksum mismatch after upload' }]);
    expect(drive.tree(FOLDER).has('M 42/processed/final.jpg')).toBe(false);
    const manifestFile = drive.tree(FOLDER).get(ARCHIVE_MANIFEST_FILENAME);
    const manifest = manifestFile ? parseArchiveManifestText(manifestFile.content.toString()) : null;
    expect(manifest?.objects['M 42']).toBeUndefined();
  });

  it('refuses when the Drive quota cannot hold what is left to send', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    drive.quota = { limit: 10, usage: 8 };
    const result = await runArchive(getArchiveConfig());
    expect(result).toMatchObject({ ran: false, reason: 'insufficient-space' });
  });

  it('never replaces a record it cannot read', async () => {
    configureGdrive();
    await adopt();
    seedLibrary();
    const folder = [...drive.files.values()].find(f => f.name === FOLDER)!;
    drive.seed(folder.id, ARCHIVE_MANIFEST_FILENAME, 'truncated{');
    const result = await runArchive(getArchiveConfig());
    expect(result.failures[0].archiveRelPath).toBe('(manifest)');
    expect(drive.tree(FOLDER).get(ARCHIVE_MANIFEST_FILENAME)?.content.toString()).toBe('truncated{');
  });
});

describe('the Nebulis database', () => {
  it('each run takes a snapshot and uploads every local snapshot Drive does not have', async () => {
    configureGdrive();
    await adopt();
    createManualDatabaseBackup();

    const result = await runArchive(getArchiveConfig(), { takeDatabaseSnapshot: () => void createCloudDatabaseBackup() });
    expect(result.failures).toEqual([]);

    const names = [...drive.tree(FOLDER).keys()].filter(k => k.startsWith(`${GDRIVE_DATABASE_FOLDER}/`));
    expect(names.some(n => n.endsWith('-manual.db'))).toBe(true);
    expect(names.some(n => n.endsWith('-cloud.db'))).toBe(true);
    // A real, verified copy of the snapshot.
    const local = fs.readdirSync(path.join(TEST_DATA_DIR, 'backups')).find(n => n.endsWith('-manual.db'))!;
    const remote = drive.tree(FOLDER).get(`${GDRIVE_DATABASE_FOLDER}/${local}`)!;
    expect(md5(remote.content)).toBe(md5(fs.readFileSync(path.join(TEST_DATA_DIR, 'backups', local))));
  });

  it('uploads a manual snapshot on its own when the Drive archive is on, and does nothing otherwise', async () => {
    configureGdrive();
    await adopt();
    createManualDatabaseBackup();
    const result = await uploadDatabaseBackupsToGdrive(getArchiveConfig());
    expect(result).toMatchObject({ uploaded: 1, failures: [] });
    // Already there: nothing more to send.
    expect(await uploadDatabaseBackupsToGdrive(getArchiveConfig())).toMatchObject({ uploaded: 0 });

    setArchiveConfig({ enabled: false });
    expect(await uploadDatabaseBackupsToGdrive(getArchiveConfig())).toBeNull();
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

    await uploadDatabaseBackupsToGdrive(getArchiveConfig());
    const remaining = [...drive.tree(FOLDER).keys()].filter(k => k.startsWith(`${GDRIVE_DATABASE_FOLDER}/`));
    expect(remaining.filter(n => n.endsWith('-cloud.db'))).toHaveLength(GDRIVE_CLOUD_SNAPSHOTS_KEPT);
    expect(remaining).toContain(`${GDRIVE_DATABASE_FOLDER}/nebulis-db-20200101T000000.000Z-v1.0.0-upgrade.db`);
    expect(remaining).toContain(`${GDRIVE_DATABASE_FOLDER}/notes.txt`);
    // Into the bin, not gone.
    expect([...drive.files.values()].filter(f => f.trashed)).toHaveLength(3);
  });
});

describe('Drive client', () => {
  function client(fetchImpl: typeof fetch, chunkBytes = 4): DriveClient {
    return new DriveClient({ getAccessToken: async () => 'access-token', fetch: fetchImpl, backoffMs: () => 0, chunkBytes });
  }

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
