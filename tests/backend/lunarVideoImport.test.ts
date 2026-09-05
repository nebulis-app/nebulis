import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Mirrors importSkipReporting.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-lunarvideo-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { runImport, claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { getLocalObservations, getLocalFiles } from '../../server/lib/library/observations';
import { createProfile } from '../../server/lib/telescopes';

const TIMELAPSE_NAME = '2026-08-27-202843-Lunar-timelapse.mp4';

describe('SeeStar lunar timelapse import', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    releaseImportLock();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('lands the .mp4 under Moon, keeps its name, and dates it to an observation', async () => {
    // SeeStar writes lunar video into a `<target>_video` folder under MyWorks.
    const deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lunarvideo-device-'));
    const videoFolder = path.join(deviceRoot, 'MyWorks', 'Lunar_video');
    fs.mkdirSync(videoFolder, { recursive: true });
    fs.writeFileSync(path.join(videoFolder, TIMELAPSE_NAME), 'fake mp4 bytes');

    const profile = createProfile({
      name: 'Lunar Video SeeStar',
      kind: 'seestar-s50',
      connectionType: 'local',
      localPath: deviceRoot,
      importVideos: true,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    // `Lunar_video` -> `Lunar` (capture-mode suffix) -> `Moon` (alias). The file
    // is copied verbatim into the object folder, not renamed.
    const moonDir = path.join(TEST_DATA_DIR, 'library', 'Moon');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]);
    expect(walk(moonDir)).toContain(TIMELAPSE_NAME);

    // It attaches to the 2026-08-27 observation rather than floating dateless.
    const observations = getLocalObservations();
    const lunarNight = observations.find(o => o.objectId === 'Moon' && o.date === '2026-08-27');
    expect(lunarNight).toBeDefined();

    // And it is served as a video file with an inline stream URL.
    const files = getLocalFiles('Moon', '2026-08-27');
    const video = files.find(f => f.name === TIMELAPSE_NAME);
    expect(video).toBeDefined();
    expect(video!.type).toBe('video');
    expect(video!.fileType).toBe('video');
    expect(video!.videoUrl).toContain('/library/video?path=');
  });
});
