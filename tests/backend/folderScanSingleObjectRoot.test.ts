import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-singleobjectroot-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { collectObjectSources } from '../../server/lib/library/folderScan';

/**
 * The wizard can be pointed at one object's own folder. Its neighbours must never be offered, and a folder that
 * only holds nights is that one object's sessions, not one object per night.
 */
describe('collectObjectSources: a folder that is one object', () => {
  let base: string;

  function put(rel: string): void {
    const file = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  const names = (root: string) => collectObjectSources(root).sources.map(s => s.folderName).sort();

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'single-object-root-'));
    for (const i of [1, 2, 3]) {
      put(`Astro/IC444/Light_000${i}.fit`);
      put(`Astro/NGC1499/2025-03-01_2126/lights/L_${i}.fit`);
      put(`Astro/NGC1499/2025-03-02_2001/lights/L_${i}.fit`);
      put(`Astro/M31/LIGHTS/L_${i}.fit`);
    }
    put('Astro/Sh2-129/20250301/a.fit');
    put('Astro/Sh2-129/20250302/a.fit');
    put('Astro/Sh2-129/RESTACKED/skip.fit');
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('offers only a flat folder, named for the folder, when it is the root', () => {
    expect(names(path.join(base, 'Astro', 'IC444'))).toEqual(['IC444']);
  });

  it('reads night sub-folders as sessions of the one object', () => {
    const sources = collectObjectSources(path.join(base, 'Astro', 'NGC1499')).sources;
    expect(sources.map(s => s.folderName)).toEqual(['NGC1499']);
    expect(sources[0].sourceDirs).toEqual([path.join(base, 'Astro', 'NGC1499')]);
  });

  it('does the same for compact dates and still reports excluded folders', () => {
    const result = collectObjectSources(path.join(base, 'Astro', 'Sh2-129'));
    expect(result.sources.map(s => s.folderName)).toEqual(['Sh2-129']);
    expect(result.excludedFolders).toEqual(['RESTACKED']);
  });

  it('still offers every object when the parent is the root', () => {
    expect(names(path.join(base, 'Astro'))).toEqual(['IC444', 'M31', 'NGC1499', 'Sh2-129']);
  });
});
