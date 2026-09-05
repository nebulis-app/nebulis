import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isGenericSessionFolder,
  discoverGenericObjects,
  listGenericObjectFiles,
  buildGenericFilePath,
} from '../../server/lib/walkers/genericWalker';
import type { TelescopeProfile } from '../../server/lib/telescopes';

describe('isGenericSessionFolder', () => {
  it('recognizes the documented YYYY-MM-DD_HHMM format', () => {
    expect(isGenericSessionFolder('2026-04-26_2030')).toBe(true);
  });

  it('rejects folders that do not match the pattern', () => {
    expect(isGenericSessionFolder('lights')).toBe(false);
    expect(isGenericSessionFolder('2026-04-26')).toBe(false);
    expect(isGenericSessionFolder('2026-04-26_20:30')).toBe(false);
  });
});

describe('discoverGenericObjects / listGenericObjectFiles — documented Generic SMB Layout', () => {
  let root: string;
  let profile: TelescopeProfile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-generic-smb-'));
    profile = { connectionType: 'local', localPath: root } as TelescopeProfile;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, content = ''): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('discovers an object with a valid session (lights/ has at least one file)', async () => {
    write('M31/2026-04-26_2030/lights/M31_stacked.fit', 'x');
    write('M31/2026-04-26_2030/lights/M31_stacked.jpg', 'x');

    const objects = await discoverGenericObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0].folderName).toBe('M31');
    expect(objects[0]._genericSessionFolders).toEqual(['2026-04-26_2030']);
  });

  it('skips an object whose session folder has no lights/ subfolder', async () => {
    write('NGC1788/2026-04-15_2200/subframes/NGC1788_001.fit', 'x');

    const objects = await discoverGenericObjects(profile);
    expect(objects).toHaveLength(0);
  });

  it('skips an object whose lights/ folder exists but is empty', async () => {
    fs.mkdirSync(path.join(root, 'M42/2026-05-01_2100/lights'), { recursive: true });

    const objects = await discoverGenericObjects(profile);
    expect(objects).toHaveLength(0);
  });

  it('ignores subfolders that do not match the session-folder date pattern', async () => {
    write('M31/not-a-session/lights/foo.jpg', 'x');
    write('M31/2026-04-26_2030/lights/M31_stacked.jpg', 'x');

    const objects = await discoverGenericObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0]._genericSessionFolders).toEqual(['2026-04-26_2030']);
  });

  it('finds multiple sessions under one object', async () => {
    write('M31/2026-04-26_2030/lights/a.jpg', 'x');
    write('M31/2026-05-03_2115/lights/b.jpg', 'x');

    const objects = await discoverGenericObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0]._genericSessionFolders?.sort()).toEqual(['2026-04-26_2030', '2026-05-03_2115']);
  });

  it('lists lights/ files into `files` and subframes/ files into `subFiles`, tagged with their session path', async () => {
    write('M31/2026-04-26_2030/lights/M31_stacked.fit');
    write('M31/2026-04-26_2030/lights/M31_stacked.jpg');
    write('M31/2026-04-26_2030/subframes/M31_001.fit');
    write('M31/2026-04-26_2030/subframes/M31_002.fit');
    write('M31/2026-04-26_2030/meta.json', '{"exposureSec":30,"frameCount":42}');

    const objects = await discoverGenericObjects(profile);
    const { files, subFiles } = await listGenericObjectFiles(profile, objects[0]);

    const fileNames = files.map(f => f.name).sort();
    expect(fileNames).toEqual([
      '2026-04-26_2030/lights/M31_stacked.fit',
      '2026-04-26_2030/lights/M31_stacked.jpg',
      '2026-04-26_2030/meta.json',
    ]);
    expect(subFiles.map(f => f.name).sort()).toEqual([
      '2026-04-26_2030/subframes/M31_001.fit',
      '2026-04-26_2030/subframes/M31_002.fit',
    ]);
  });

  it('round-trips through buildGenericFilePath back to the real file on disk', async () => {
    write('M31/2026-04-26_2030/lights/M31_stacked.jpg', 'the bytes');

    const objects = await discoverGenericObjects(profile);
    const { files } = await listGenericObjectFiles(profile, objects[0]);
    const remotePath = buildGenericFilePath(objects[0], files[0].name);

    expect(remotePath).toBe('M31/2026-04-26_2030/lights/M31_stacked.jpg');
    expect(fs.readFileSync(path.join(root, remotePath), 'utf8')).toBe('the bytes');
  });
});
