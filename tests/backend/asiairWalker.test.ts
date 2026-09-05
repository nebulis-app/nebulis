import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  discoverAsiairObjects,
  listAsiairObjectFiles,
  asiairLocalName,
  resolveAsiairRoot,
  clearAsiairRootCache,
  ASIAIR_CALIBRATION_PATHS,
} from '../../server/lib/walkers/asiairWalker';
import type { TelescopeProfile } from '../../server/lib/telescopes';

describe('ASIAIR walker', () => {
  let root: string;
  let profile: TelescopeProfile;
  let profileSeq = 0;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-asiair-'));
    // The resolved root is cached per profile id, so each test gets its own id
    // (and the cache is cleared) to keep one test's tree out of the next.
    clearAsiairRootCache();
    profile = { id: `asiair-test-${profileSeq++}`, connectionType: 'local', localPath: root } as TelescopeProfile;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, content = 'x'): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const LIGHT = 'Light_M42_10.0s_Bin1_S_gain360_20240320-203324_-10.0C_0001.fit';

  it('discovers a target under Autorun/Light', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);

    const objects = await discoverAsiairObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0].folderName).toBe('M42');
    expect(objects[0]._asiairSources).toHaveLength(1);
  });

  it('unions the same target across Autorun, Plan and Live into one object', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);
    write('Plan/Light/M42/Light_M42_300.0s_Bin1_Ha_gain100_20240321-010000_-10.0C_0001.fit');
    write('Live/M42/Live_Stack_M42.fit');

    const objects = await discoverAsiairObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0]._asiairSources).toHaveLength(3);
  });

  it('treats differently-spaced spellings of one target as the same object', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);
    write('Plan/Light/M 42/Light_M 42_300.0s_Bin1_Ha_gain100_20240321-010000_-10.0C_0001.fit');

    const objects = await discoverAsiairObjects(profile);
    expect(objects).toHaveLength(1);
    // First spelling seen wins as the display name.
    expect(objects[0].folderName).toBe('M42');
    expect(objects[0]._asiairSources).toHaveLength(2);
  });

  it('sorts Live output into files and Autorun/Plan frames into subFiles', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);
    write('Live/M42/Live_Stack_M42.fit');

    const [object] = await discoverAsiairObjects(profile);
    const { files, subFiles } = await listAsiairObjectFiles(profile, object);

    expect(files).toHaveLength(1);
    expect(asiairLocalName(files[0].name)).toBe('Live_Stack_M42.fit');
    expect(subFiles).toHaveLength(1);
    expect(asiairLocalName(subFiles[0].name)).toBe(LIGHT);
  });

  it('tags listed files with a path that resolves back to the real file', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);

    const [object] = await discoverAsiairObjects(profile);
    const { subFiles } = await listAsiairObjectFiles(profile, object);

    // The tagged name is the remote path, so joining it to the share root must
    // land on the file the walker found.
    expect(fs.existsSync(path.join(root, subFiles[0].name))).toBe(true);
    expect(subFiles[0].name).toBe(`Autorun/Light/M42/${LIGHT}`);
  });

  it('never surfaces calibration folders as objects', async () => {
    write(`Autorun/Light/M42/${LIGHT}`);
    write('Autorun/Dark/Dark_60s_Bin1_20250723-13073265_0018.fit');
    write('Autorun/Flat/Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit');
    write('Autorun/Bias/Bias_0.001s_Bin1_gain100_20240320-233122_-10.5C_0003.fit');

    const objects = await discoverAsiairObjects(profile);
    expect(objects.map(o => o.folderName)).toEqual(['M42']);
  });

  it('exposes every calibration path the archive pass needs to sweep', () => {
    expect([...ASIAIR_CALIBRATION_PATHS]).toEqual([
      'Autorun/Dark', 'Autorun/Flat', 'Autorun/Bias',
      'Plan/Dark', 'Plan/Flat', 'Plan/Bias',
    ]);
  });

  it('groups loose frames with no target folder by the target in their filename', async () => {
    // Older firmware wrote straight into Light/ with no per-target folder.
    write(`Autorun/Light/${LIGHT}`);
    write('Autorun/Light/Light_NGC7000_120.0s_Bin1_Ha_gain100_20240320-221500_-10.0C_0001.fit');

    const objects = await discoverAsiairObjects(profile);
    expect(objects.map(o => o.folderName).sort()).toEqual(['M42', 'NGC7000']);

    const m42 = objects.find(o => o.folderName === 'M42')!;
    const { subFiles } = await listAsiairObjectFiles(profile, m42);
    // Only M42's own loose file, not NGC7000's, despite sharing a directory.
    expect(subFiles.map(f => asiairLocalName(f.name))).toEqual([LIGHT]);
  });

  it('descends into the ASIAir/ folder that removable storage carries', async () => {
    write(`ASIAir/Autorun/Light/M42/${LIGHT}`);

    expect(await resolveAsiairRoot(profile)).toBe('ASIAir');

    const objects = await discoverAsiairObjects(profile);
    expect(objects).toHaveLength(1);
    expect(objects[0].folderName).toBe('M42');

    const { subFiles } = await listAsiairObjectFiles(profile, objects[0]);
    expect(subFiles[0].name).toBe(`ASIAir/Autorun/Light/M42/${LIGHT}`);
  });

  it('does not descend into an ASIAir/ folder that holds something else', async () => {
    write('ASIAir/notes.txt', 'not a capture tree');
    write(`Autorun/Light/M42/${LIGHT}`);

    expect(await resolveAsiairRoot(profile)).toBe('');
  });

  it('returns no objects for a tree with no ASIAIR folders at all', async () => {
    write('random/file.fit');

    const objects = await discoverAsiairObjects(profile);
    expect(objects).toEqual([]);
  });
});
