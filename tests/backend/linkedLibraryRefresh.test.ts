import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedrefresh-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import {
  commitSource, setRefreshInterval, listDueSources, getLibrarySource, summarizeSources, LinkSourceError,
} from '../../server/lib/library/librarySources';
import { tickLinkedSourceRefresh } from '../../server/lib/library/linkedSourceScheduler';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };
const HOUR = 60 * 60_000;
const roots: string[] = [];

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
  ensureLibraryDir();
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-refresh-source-'));
  roots.push(root);
  const m31 = path.join(root, 'Galaxies', 'M 31 - Andromeda');
  fs.mkdirSync(m31, { recursive: true });
  fs.writeFileSync(path.join(m31, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
  return root;
}

const stampScan = (id: string, at: number) =>
  db.prepare('UPDATE librarySources SET lastScanAt = ? WHERE id = ?').run(new Date(at).toISOString(), id);

describe('linked folder refresh schedule', () => {
  it('a source linked without a schedule is one-time and never due', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x' });
    expect(getLibrarySource(sourceId)?.refreshIntervalMin).toBeNull();
    stampScan(sourceId, Date.now() - 365 * 24 * HOUR);
    expect(listDueSources()).toEqual([]);
  });

  it('stores the interval chosen at link time and reports it in the summary', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x', refreshIntervalMin: 1440 });
    expect(getLibrarySource(sourceId)?.refreshIntervalMin).toBe(1440);
    expect(summarizeSources()[0]).toMatchObject({ id: sourceId, refreshIntervalMin: 1440 });
  });

  it('is due only once its interval has elapsed since the last scan', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x', refreshIntervalMin: 60 });
    const t0 = Date.now();
    stampScan(sourceId, t0);
    expect(listDueSources(t0 + 59 * 60_000)).toEqual([]);
    expect(listDueSources(t0 + HOUR).map(s => s.id)).toEqual([sourceId]);
  });

  it('a disabled source is never due', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x', refreshIntervalMin: 60 });
    stampScan(sourceId, Date.now() - 48 * HOUR);
    db.prepare('UPDATE librarySources SET enabled = 0 WHERE id = ?').run(sourceId);
    expect(listDueSources()).toEqual([]);
  });

  it('setRefreshInterval switches a source between one-time and ongoing, and rejects other values', () => {
    const { sourceId } = commitSource(makeRoot(), SETTINGS, { label: 'x' });
    expect(setRefreshInterval(sourceId, 360).refreshIntervalMin).toBe(360);
    expect(setRefreshInterval(sourceId, null).refreshIntervalMin).toBeNull();
    expect(() => setRefreshInterval(sourceId, 7)).toThrow(LinkSourceError);
    expect(() => setRefreshInterval('src_missing', 60)).toThrow(/no longer exists/);
  });
});

describe('tickLinkedSourceRefresh', () => {
  it('rescans a due source, picks up a file added since the link, and leaves one-time sources alone', async () => {
    const ongoingRoot = makeRoot();
    const onceRoot = makeRoot();
    const ongoing = commitSource(ongoingRoot, SETTINGS, { label: 'ongoing', refreshIntervalMin: 60 }).sourceId;
    const once = commitSource(onceRoot, SETTINGS, { label: 'once' }).sourceId;
    for (const root of [ongoingRoot, onceRoot]) {
      fs.writeFileSync(
        path.join(root, 'Galaxies', 'M 31 - Andromeda', 'Stacked_60_M 31_10.0s_IRCUT_20260102-200000.jpg'),
        'b'.repeat(100),
      );
    }
    stampScan(ongoing, Date.now() - 2 * HOUR);
    stampScan(once, Date.now() - 2 * HOUR);

    const result = await tickLinkedSourceRefresh();
    expect(result).toEqual({ ran: [ongoing], skippedBecause: null });

    const count = (id: string) =>
      db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE sourceId = ?').get(id)?.n;
    expect(count(ongoing)).toBe(2);
    expect(count(once)).toBe(1);

    // Just scanned, so the next tick has nothing to do.
    expect((await tickLinkedSourceRefresh()).ran).toEqual([]);
  });

  it('marks an unreachable folder offline without touching its files, and does not retry until the next interval', async () => {
    const root = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', refreshIntervalMin: 60 });
    stampScan(sourceId, Date.now() - 2 * HOUR);
    fs.rmSync(root, { recursive: true, force: true });

    expect((await tickLinkedSourceRefresh()).ran).toEqual([sourceId]);
    expect(db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE sourceId = ?').get(sourceId)?.n).toBe(1);
    expect(listDueSources()).toEqual([]);
  });
});
