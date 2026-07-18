import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-purge-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { purgeSubFrameImages } from '../../server/lib/library/observations';
import { LIBRARY_DIR } from '../../server/lib/paths';

const OBJ = 'M42';
const objDir = () => path.join(LIBRARY_DIR, OBJ);
const write = (name: string) => fs.writeFileSync(path.join(objDir(), name), 'x');

describe('purgeSubFrameImages', () => {
  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
    fs.mkdirSync(objDir(), { recursive: true });
  });

  it('deletes frame-named JPGs but keeps raw .fit subs and stacked JPGs', () => {
    // Object names with spaces ("M 16") are the real-world case that regressed.
    const lightJpg = 'Light_M 16_20.0s_LP_20260604-025129.jpg';
    const subJpg = 'sub_0001_M 16_20.0s_LP_20260604-025129.jpg';
    const lightFit = 'Light_M 16_20.0s_LP_20260604-025129.fit';
    const stackedJpg = 'DSO_Stacked_92_M 16_30.0s_20250322_062504.jpg';
    [lightJpg, subJpg, lightFit, stackedJpg].forEach(write);

    // Dry run reports without deleting.
    const dry = purgeSubFrameImages({ dryRun: true });
    expect(dry.matched).toBe(2);
    expect(dry.deleted).toBe(0);
    expect(fs.existsSync(path.join(objDir(), lightJpg))).toBe(true);

    // Real run deletes only the two frame-named images.
    const res = purgeSubFrameImages();
    expect(res.deleted).toBe(2);
    expect(res.errors).toBe(0);
    expect(fs.existsSync(path.join(objDir(), lightJpg))).toBe(false);
    expect(fs.existsSync(path.join(objDir(), subJpg))).toBe(false);
    expect(fs.existsSync(path.join(objDir(), lightFit))).toBe(true);
    expect(fs.existsSync(path.join(objDir(), stackedJpg))).toBe(true);
  });

  it('is a no-op when there are no frame-named images', () => {
    write('Stacked_30_M42_10.0s_IRCUT_20260407-043257.jpg');
    write('Light_M42_10.0s_IRCUT_20260407-043257.fit');
    const res = purgeSubFrameImages();
    expect(res.deleted).toBe(0);
    expect(res.matched).toBe(0);
  });
});
