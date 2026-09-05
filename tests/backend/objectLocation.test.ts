import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-objectlocation-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { createManualObservation } from '../../server/lib/library/import';
import { getObjectLocation } from '../../server/lib/library/objectLocation';
import { LIBRARY_DIR } from '../../server/lib/paths';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('getObjectLocation', () => {
  it('returns the absolute on-disk folder for an object', async () => {
    createManualObservation('NGC7000', '2026-02-01', Buffer.from('jpg'), 'jpg');

    const loc = await getObjectLocation('NGC7000');
    expect(loc.storage).toBe('local');
    expect(loc.object.relPath).toBe('NGC7000');
    expect(loc.object.path).toBe(path.join(LIBRARY_DIR, 'NGC7000'));
    expect(loc.object.exists).toBe(true);
    expect(fs.existsSync(loc.object.path)).toBe(true);
    expect(loc.session).toBeNull();
  });

  it('scopes to a session folder when given a date', async () => {
    createManualObservation('NGC7000', '2026-02-02', Buffer.from('jpg'), 'jpg');
    const loc = await getObjectLocation('NGC7000', '2026-02-02');
    expect(loc.session).not.toBeNull();
    // Flat SeeStar-style layout: the session's files sit in the object folder.
    expect(loc.session!.path.startsWith(path.join(LIBRARY_DIR, 'NGC7000'))).toBe(true);
    expect(loc.session!.exists).toBe(true);
  });

  it('does not throw for an object that is not in the library', async () => {
    const loc = await getObjectLocation('NOT_A_REAL_OBJECT');
    expect(loc.object.exists).toBe(false);
  });
});
