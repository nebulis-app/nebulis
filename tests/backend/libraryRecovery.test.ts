/**
 * A relocated library whose drive comes back at a different path is found again by its marker, instead of the app
 * calling the library unavailable (and offering a "reset" that starts a second library on the internal disk).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-recovery-test-'));
  process.env.DATA_DIR = dir;
  return { dir, volumes: { list: [] as { path: string }[] } };
});

vi.mock('../../server/lib/volumes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/lib/volumes')>();
  return { ...real, listVolumes: vi.fn(async () => H.volumes.list) };
});

import {
  setLibraryPath, isLibraryAvailable, getLibraryDir, getLibraryId, writeMarker, getLibraryRecovery, resetLibraryRecovery,
  retireLibraryCopy, getLibraryLocationInfo,
} from '../../server/lib/libraryPath';
import { RETIRED_MARKER_FILENAME } from '../../server/lib/libraryLocator';

afterAll(() => fs.rmSync(H.dir, { recursive: true, force: true }));

let n = 0;
/** A fresh "volume" folder under the test dir. */
const volume = () => fs.mkdtempSync(path.join(H.dir, `vol-${++n}-`));

beforeEach(async () => {
  await setLibraryPath('');
  resetLibraryRecovery();
  H.volumes.list = [];
});

describe('a library whose drive came back at a different path', () => {
  it('is reconnected at its new path, and says so', async () => {
    const wasAt = path.join(volume(), 'library'); // The drive that is gone.
    await setLibraryPath(wasAt);
    const back = volume();
    const newHome = path.join(back, 'library');
    fs.mkdirSync(newHome);
    writeMarker(newHome, getLibraryId());
    H.volumes.list = [{ path: back }];

    expect(await isLibraryAvailable()).toBe(true);

    expect(getLibraryDir()).toBe(newHome);
    expect(getLibraryRecovery()).toMatchObject({ from: wasAt, to: newHome });
    expect((await getLibraryLocationInfo()).recovered?.to).toBe(newHome);
  });

  it('stays unavailable, and changes nothing, when no mounted drive holds the library', async () => {
    const wasAt = path.join(volume(), 'library');
    await setLibraryPath(wasAt);
    H.volumes.list = [{ path: volume() }];

    expect(await isLibraryAvailable()).toBe(false);
    expect(getLibraryDir()).toBe(wasAt);
    expect(getLibraryRecovery()).toBeNull();
  });

  it('does not reconnect to the old copy a move left behind', async () => {
    const oldCopyRoot = volume();
    const oldCopy = path.join(oldCopyRoot, 'library');
    fs.mkdirSync(oldCopy);
    writeMarker(oldCopy, getLibraryId());
    retireLibraryCopy(oldCopy, '/Volumes/Somewhere/library');
    expect(fs.existsSync(path.join(oldCopy, RETIRED_MARKER_FILENAME))).toBe(true);

    // The real library moved to a drive that is not plugged in now.
    await setLibraryPath(path.join(volume(), 'library'));
    H.volumes.list = [{ path: oldCopyRoot }];

    expect(await isLibraryAvailable()).toBe(false);
    expect(getLibraryRecovery()).toBeNull();
  });

  it('does not reconnect when two folders both claim to be the library', async () => {
    await setLibraryPath(path.join(volume(), 'library'));
    const a = volume();
    const b = volume();
    for (const v of [a, b]) writeMarker(v, getLibraryId());
    H.volumes.list = [{ path: a }, { path: b }];

    expect(await isLibraryAvailable()).toBe(false);
    expect(getLibraryRecovery()).toBeNull();
  });

  it('is not searched for again straight away after a miss', async () => {
    await setLibraryPath(path.join(volume(), 'library'));
    const back = volume();
    H.volumes.list = [];
    expect(await isLibraryAvailable()).toBe(false);

    // The drive arrives, but the last search was moments ago.
    writeMarker(back, getLibraryId());
    H.volumes.list = [{ path: back }];
    expect(await isLibraryAvailable()).toBe(false);

    resetLibraryRecovery();
    expect(await isLibraryAvailable()).toBe(true);
  });

  it('forgets an old copy\'s note once that folder is the library again', () => {
    const dir = volume();
    retireLibraryCopy(dir, '/elsewhere');
    writeMarker(dir, getLibraryId());
    expect(fs.existsSync(path.join(dir, RETIRED_MARKER_FILENAME))).toBe(false);
  });
});
