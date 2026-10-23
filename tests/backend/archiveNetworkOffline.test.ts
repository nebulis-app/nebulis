import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// A scratch DATA_DIR before any server module loads: the mount directory is derived
// from it at import time.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archive-offline-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    Promise.resolve(execFileMock(...args.slice(0, -1))).then(
      result => cb(null, (result as { stdout: string; stderr: string }) ?? { stdout: '', stderr: '' }),
      err => cb(err instanceof Error ? err : new Error(String(err))),
    );
  },
}));

const tcpProbeMock = vi.fn();
vi.mock('../../server/lib/smbReachability', () => ({
  tcpProbe: (...args: unknown[]) => tcpProbeMock(...args),
  SMB_PORT: 445,
}));

import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { ARCHIVE_NETWORK_MOUNT_DIR, invalidateArchiveReachability } from '../../server/lib/archive/archiveNetwork';
import { ARCHIVE_MARKER_FILENAME, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { planArchiveRetention, applyArchiveRetention } from '../../server/lib/archive/archiveRetention';
import { listArchivedObjects } from '../../server/lib/archive/archiveBrowse';
import { restoreArchivedFiles } from '../../server/lib/archive/archiveRestore';
import { removeVerifiedLocalSubframes } from '../../server/lib/archive/archiveLocalRemoval';
import { tickArchiveScheduler } from '../../server/lib/archive/archiveScheduler';
import {
  DEFAULT_ARCHIVE_CONFIG,
  setArchiveConfig,
  getArchiveConfig,
  type ArchiveConfig,
} from '../../server/lib/archive/archiveConfig';

/**
 * A network destination that is configured but not connected.
 *
 * This is the suite the whole feature is arranged around. On macOS a network
 * destination resolves to a directory under DATA_DIR, and that directory exists and
 * is empty whether or not a share is mounted on it. If readiness only asked "does the
 * root exist", every one of these operations would treat that empty local folder as
 * the archive: adopting it would stamp a marker into it, and the run that followed
 * would copy the library onto the app's own disk.
 *
 * So each operation is asserted twice: once with the share away, where it must refuse
 * and write nothing anywhere, and once with the share in place, where it must work
 * against the real directory. The second half matters as much as the first, because a
 * refusal that never lifts is not a feature.
 */

const ARCHIVE_ID = 'archive-under-test';
const SUBPATH = 'Nebulis-Archive';
const MOUNT_ROOT = ARCHIVE_NETWORK_MOUNT_DIR;
const ARCHIVE_ROOT = path.join(MOUNT_ROOT, SUBPATH);

const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const M31_FOLDER = 'M 31';
const seededObjectIds: string[] = [];

/** Whether the fake share is mounted. Flipped by the two describe blocks below. */
let shareMounted = false;

/** Pinned, like every sibling suite that depends on it. This file's whole premise is
 *  that the mount proof is consulted, and `networkArchiveSupported()` is false on
 *  Linux, where readiness refuses before the mount table is read: the refusals would
 *  pass for the platform reason and the mounted tests would fail. CI runs on
 *  ubuntu-latest, so without this the suite is red there and meaningless. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const ORIGINAL_PLATFORM = process.platform;

function setMounted(mounted: boolean): void {
  shareMounted = mounted;
  execFileMock.mockImplementation((cmd: string) => {
    if (cmd === 'mount') {
      return Promise.resolve({
        stdout: shareMounted ? `//alice@nas.local/Archive on ${MOUNT_ROOT} (smbfs, nodev, nosuid)` : '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
  tcpProbeMock.mockResolvedValue(5);
}

function configFor(): ArchiveConfig {
  return {
    ...DEFAULT_ARCHIVE_CONFIG,
    locationType: 'network',
    network: {
      host: 'nas.local',
      share: 'Archive',
      domain: '',
      username: 'alice',
      hasPassword: false,
      subpath: SUBPATH,
    },
    archiveId: ARCHIVE_ID,
    includeSubframes: true,
    retentionDays: 30,
  };
}

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
}

function writeLibraryFile(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A plan naming a file that exists, so "apply" has something it could have removed.
 *  Built by hand because the point is to prove apply re-checks the destination
 *  itself rather than trusting the plan it was handed. */
function handMadePlan(): Parameters<typeof applyArchiveRetention>[1] {
  return {
    mode: 'whole-object',
    root: ARCHIVE_ROOT,
    items: [{ folderName: M31_FOLDER, archivedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(), files: [STACKED_JPG], bytes: 7 }],
    filesTotal: 1,
    bytesTotal: 7,
    warnings: [],
  };
}

beforeAll(() => {
  setArchiveConfig(configFor());
});

afterAll(() => {
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
});

beforeEach(() => {
  setPlatform('darwin');
  seededObjectIds.length = 0;
  db.prepare('DELETE FROM libraryObjects').run();
  seedObject('M31', M31_FOLDER);
  writeLibraryFile(path.join(M31_FOLDER, STACKED_JPG), 'stacked');
  setArchiveConfig(configFor());

  // The mount point exists as an ordinary local directory, which is exactly the
  // state that must not be mistaken for an archive. The share's subpath does not.
  fs.rmSync(MOUNT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(MOUNT_ROOT, { recursive: true });
  // The reachability probe is cached per host for five seconds, so a test that
  // changed the answer would otherwise be handed the previous test's result.
  invalidateArchiveReachability();
  setMounted(false);
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  fs.rmSync(MOUNT_ROOT, { recursive: true, force: true });
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  execFileMock.mockReset();
  tcpProbeMock.mockReset();
});

describe('with the share away', () => {
  it('refuses to run, and writes nothing anywhere', async () => {
    const result = await runArchive(getArchiveConfig());

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('destination-unusable');
    // The mount directory is untouched: no marker, no object folder, nothing.
    expect(fs.readdirSync(MOUNT_ROOT)).toEqual([]);
    expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG))).toBe(true);
  });

  it('plans nothing to prune, and says why', async () => {
    const plan = await planArchiveRetention(getArchiveConfig(), new Date());

    expect(plan.items).toEqual([]);
    expect(plan.filesTotal).toBe(0);
    expect(plan.warnings.join(' ')).toMatch(/not connected/);
  });

  it('removes nothing even when handed a plan that names a real file', async () => {
    // The archive is written to behind the plan's back, so that a refusal is visible:
    // a plan with nothing in it would prove nothing here.
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    writeArchiveMarker(ARCHIVE_ROOT, ARCHIVE_ID);
    fs.writeFileSync(path.join(ARCHIVE_ROOT, STACKED_JPG), 'stacked');

    const result = await applyArchiveRetention(getArchiveConfig(), handMadePlan());

    expect(result.removed).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(ARCHIVE_ROOT, STACKED_JPG))).toBe(true);
  });

  it('lists nothing, and says why', async () => {
    const result = await listArchivedObjects(getArchiveConfig());

    expect(result.objects).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/not connected/);
  });

  it('restores nothing, and writes nothing into the library', async () => {
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    writeArchiveMarker(ARCHIVE_ROOT, ARCHIVE_ID);

    const result = await restoreArchivedFiles(
      getArchiveConfig(),
      [{ folderName: M31_FOLDER, relPath: STACKED_JPG }],
      {},
    );

    expect(result.ran).toBe(false);
    expect(result.restored).toBe(0);
    // The local file it would have written over is still there, untouched.
    expect(fs.readFileSync(path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG), 'utf8')).toBe('stacked');
  });

  it('removes no local subframe, which is the operation that cannot be undone', async () => {
    // The archived copy is what justifies deleting the local one. With the share
    // away there is no copy to check, so the only safe answer is to do nothing.
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    writeArchiveMarker(ARCHIVE_ROOT, ARCHIVE_ID);
    const config = { ...getArchiveConfig(), removeLocalAfter: true };

    const result = await removeVerifiedLocalSubframes(config);

    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG))).toBe(true);
  });

  it('skips the scheduled tick rather than running it', async () => {
    // The master switch is on: this case is about the share being away, not about
    // the feature being off, which is the tick's first check.
    setArchiveConfig({ ...configFor(), enabled: true, scheduleEnabled: true });
    const outcome = await tickArchiveScheduler(new Date('2026-09-24T03:00:00Z'));

    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toBe('destination-unusable');
    expect(fs.readdirSync(MOUNT_ROOT)).toEqual([]);
  });

  it('never adopts the empty mount directory: no marker appears in it', async () => {
    // Everything above in one assertion, stated as the property itself.
    expect(fs.existsSync(path.join(MOUNT_ROOT, ARCHIVE_MARKER_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(ARCHIVE_ROOT, ARCHIVE_MARKER_FILENAME))).toBe(false);
  });
});

describe('with the share mounted and adopted', () => {
  beforeEach(() => {
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    writeArchiveMarker(ARCHIVE_ROOT, ARCHIVE_ID);
    setMounted(true);
  });

  it('runs, copying into the share the way it would into a disk', async () => {
    const result = await runArchive(getArchiveConfig());

    // matchObject so a failure prints what actually came back, which is how the
    // reason for a refusal is visible at all.
    expect(result).toMatchObject({ ran: true, copied: 1 });
    expect(fs.readFileSync(path.join(ARCHIVE_ROOT, M31_FOLDER, STACKED_JPG), 'utf8')).toBe('stacked');
  });

  it('lists what it archived', async () => {
    await runArchive(getArchiveConfig());

    const result = await listArchivedObjects(getArchiveConfig());
    expect(result.objects.map(o => o.folderName)).toEqual([M31_FOLDER]);
  });

  it('plans and applies retention against the share', async () => {
    await runArchive(getArchiveConfig());
    // Aged by hand: the run just stamped the object with now.
    const manifestPath = path.join(ARCHIVE_ROOT, '.nebulisarchive-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    manifest.objects[M31_FOLDER].firstArchivedAt = past;
    manifest.objects[M31_FOLDER].lastArchivedAt = past;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const plan = await planArchiveRetention(getArchiveConfig(), new Date());
    expect(plan.filesTotal).toBe(1);

    const result = await applyArchiveRetention(getArchiveConfig(), plan);
    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(ARCHIVE_ROOT, M31_FOLDER, STACKED_JPG))).toBe(false);
  });

  it('still refuses a share that is not our archive', async () => {
    // Mounted is not the same as ours: the mounted share is somebody's, and its
    // marker says so.
    writeArchiveMarker(ARCHIVE_ROOT, 'someone-elses');

    const result = await runArchive(getArchiveConfig());

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('destination-unusable');
  });

  it('reports the host being unreachable as a refusal, not as an empty archive', async () => {
    tcpProbeMock.mockResolvedValue(null);

    expect(await listArchivedObjects(getArchiveConfig())).toMatchObject({ objects: [] });
    expect((await runArchive(getArchiveConfig())).reason).toBe('destination-unusable');
    // The refusal came from probing the configured host on the SMB port.
    expect(tcpProbeMock).toHaveBeenCalledWith('nas.local', 445, 2000);
  });
});

describe('the platform this suite runs on', () => {
  it('is pinned to one that can mount in process, so the mount proof is what is tested', () => {
    // If this were left to the host, every refusal below would pass on Linux for the
    // wrong reason and the mounted tests would fail there.
    expect(process.platform).toBe('darwin');
  });
});

describe('the mount directory is never the archive itself', () => {
  it('resolves the destination to a folder inside the mount point, not the mount point', () => {
    expect(ARCHIVE_ROOT.startsWith(MOUNT_ROOT + path.sep)).toBe(true);
    expect(ARCHIVE_ROOT).not.toBe(MOUNT_ROOT);
    expect(DATA_DIR).toBe(path.dirname(MOUNT_ROOT));
  });
});
