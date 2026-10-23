import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedreassign-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import {
  commitSource, rescanSource, scanSource, parseStoredOverrides, serializeOverrides,
} from '../../server/lib/library/librarySources';
import type { AttributionOverride } from '../../server/lib/library/treeAttribution';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };
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
  db.prepare('DELETE FROM notes').run();
  ensureLibraryDir();
});

/** Lay a tree of files (relPath -> content) under a fresh temp root. */
function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-reassign-source-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const COMET_15 = 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385';
const COMET_30 = 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383';
const cometTree = () => makeTree({
  [`${COMET_15}/C2025R3PANSTARRS_15s60_Astro_20260415-063816385_26C.fits`]: 'a'.repeat(300),
  [`${COMET_30}/C2025R3PANSTARRS_30s60_Astro_20260416-062117383_26C.fits`]: 'b'.repeat(300),
});

const objectOf = (sourceId: string) =>
  db.prepare<[string], { relPath: string; objectId: string }>('SELECT relPath, objectId FROM libraryFiles WHERE sourceId = ? ORDER BY relPath').all(sourceId);

describe('scanSource: one Dwarf target, several session folders', () => {
  it('reports a single object holding both sessions, and both directories it lives in', () => {
    const scan = scanSource(cometTree(), SETTINGS);
    expect(scan.objects.map(o => o.objectId)).toEqual(['C2025R3PANSTARRS']);
    const [comet] = scan.objects;
    expect(comet.fileCount).toBe(2);
    expect(comet.sessions).toHaveLength(2);
    expect(comet.dirPaths).toEqual([COMET_15, COMET_30].sort());
    expect(comet.reassignable).toBe(true);
  });
});

describe('scanSource: which objects may be re-assigned', () => {
  it('offers an object whose folders hold nothing else', () => {
    const root = makeTree({
      'Galaxies/M 31 - Andromeda/Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg': 'a'.repeat(50),
      'Galaxies/M 31 - Andromeda/M 31_sub/Light_M 31_10.0s_IRCUT_20260101-200500.fit': 'f'.repeat(50),
    });
    const [m31] = scanSource(root, SETTINGS).objects;
    expect(m31.objectId).toBe('M31');
    // The _sub companion is its own directory, and both have to move together.
    expect(m31.dirPaths).toEqual(['Galaxies/M 31 - Andromeda', 'Galaxies/M 31 - Andromeda/M 31_sub']);
    expect(m31.reassignable).toBe(true);
  });

  it('refuses when two objects share one flat directory, since a directory override would move both', () => {
    const root = makeTree({
      'Dump/Stacked_60_M 42_10.0s_IRCUT_20260101-200000.jpg': 'a'.repeat(50),
      'Dump/Stacked_40_M 43_10.0s_IRCUT_20260101-203000.jpg': 'b'.repeat(50),
    });
    const scan = scanSource(root, SETTINGS);
    expect(scan.objects.map(o => o.objectId).sort()).toEqual(['M42', 'M43']);
    expect(scan.objects.every(o => o.reassignable === false)).toBe(true);
  });

  it('refuses the outer object when a different object lives in a folder beneath it, but still offers the inner one', () => {
    const root = makeTree({
      'Sets/M 31 - Andromeda/Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg': 'a'.repeat(50),
      'Sets/M 31 - Andromeda/M 42 - Orion/Stacked_60_M 42_10.0s_IRCUT_20260102-200000.jpg': 'b'.repeat(50),
    });
    const byId = new Map(scanSource(root, SETTINGS).objects.map(o => [o.objectId, o]));
    expect(byId.get('M31')?.reassignable).toBe(false);
    expect(byId.get('M42')?.reassignable).toBe(true);
  });

  it('judges files loose in the scan root on the root alone, not on every folder beneath it', () => {
    const root = makeTree({
      'Stacked_60_M 42_10.0s_IRCUT_20260101-200000.jpg': 'a'.repeat(50),
      'M 31 - Andromeda/Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg': 'b'.repeat(50),
    });
    const byId = new Map(scanSource(root, SETTINGS).objects.map(o => [o.objectId, o]));
    expect(byId.get('M42')?.dirPaths).toEqual(['']);
    expect(byId.get('M42')?.reassignable).toBe(true);
    expect(byId.get('M31')?.reassignable).toBe(true);
  });
});

describe('stored overrides', () => {
  const sample = new Map<string, AttributionOverride>([
    ['A/B', { action: 'assign', objectId: 'M42' }],
    ['C', { action: 'ignore' }],
    ['', { action: 'assign', objectId: 'M31' }],
  ]);

  it('round-trips assign, ignore and the root directory', () => {
    expect(parseStoredOverrides(serializeOverrides(sample))).toEqual(sample);
  });

  it('reads nothing from a missing, empty or unparsable column instead of throwing', () => {
    for (const raw of [null, '', 'not json', '{"a":1}', '42', 'null']) {
      expect(parseStoredOverrides(raw).size).toBe(0);
    }
  });

  it('drops a malformed row and keeps the good ones', () => {
    const raw = JSON.stringify([
      { dirPath: 'ok', action: 'assign', objectId: 'M42' },
      { dirPath: 5, action: 'ignore' },
      { dirPath: 'no-object', action: 'assign' },
      { dirPath: 'blank-object', action: 'assign', objectId: '' },
      { dirPath: 'bad-action', action: 'delete' },
      null,
      'string',
    ]);
    expect(Array.from(parseStoredOverrides(raw))).toEqual([['ok', { action: 'assign', objectId: 'M42' }]]);
  });

  it('exists as a column on librarySources', () => {
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(librarySources)').all();
    expect(cols.some(c => c.name === 'overrides')).toBe(true);
  });
});

describe('re-assigning a linked object', () => {
  const assignBoth = new Map<string, AttributionOverride>([
    [COMET_15, { action: 'assign', objectId: 'M42' }],
    [COMET_30, { action: 'assign', objectId: 'M42' }],
  ]);

  it('links every file under the object the user chose, and stores the decision with the source', () => {
    const root = cometTree();
    const { sourceId, objectsLinked } = commitSource(root, SETTINGS, { label: 'x', overrides: assignBoth });
    expect(objectsLinked).toBe(1);
    expect(objectOf(sourceId).map(r => r.objectId)).toEqual(['M42', 'M42']);

    const stored = db.prepare<[string], { overrides: string | null }>('SELECT overrides FROM librarySources WHERE id = ?').get(sourceId);
    expect(parseStoredOverrides(stored?.overrides ?? null)).toEqual(assignBoth);
  });

  it('keeps the assignment through a rescan instead of moving the files back', () => {
    const root = cometTree();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', overrides: assignBoth });

    const rescan = rescanSource(sourceId, SETTINGS);
    // Nothing changed on disk and nothing was re-attributed: no updates, no adds, no missing.
    expect(rescan).toMatchObject({ added: 0, updated: 0, unchanged: 2, missing: 0, removed: 0 });
    expect(objectOf(sourceId).map(r => r.objectId)).toEqual(['M42', 'M42']);
  });

  it('applies a stored assignment to a file that appears after the link', () => {
    const root = cometTree();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', overrides: assignBoth });
    fs.writeFileSync(path.join(root, COMET_15, 'C2025R3PANSTARRS_15s60_Astro_20260415-063900000_26C.fits'), 'c'.repeat(300));

    const rescan = rescanSource(sourceId, SETTINGS);
    expect(rescan.added).toBe(1);
    expect(objectOf(sourceId).every(r => r.objectId === 'M42')).toBe(true);
    expect(objectOf(sourceId)).toHaveLength(3);
  });

  it('keeps an ignored folder ignored through a rescan', () => {
    const root = cometTree();
    const ignoreOne = new Map<string, AttributionOverride>([[COMET_30, { action: 'ignore' }]]);
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', overrides: ignoreOne });
    expect(objectOf(sourceId)).toHaveLength(1);

    const rescan = rescanSource(sourceId, SETTINGS);
    expect(rescan).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(objectOf(sourceId)).toHaveLength(1);
  });

  it('leaves the two sessions as one shared object when nothing is assigned', () => {
    const root = cometTree();
    const { sourceId, objectsLinked } = commitSource(root, SETTINGS, { label: 'x' });
    expect(objectsLinked).toBe(1);
    expect(new Set(objectOf(sourceId).map(r => r.objectId))).toEqual(new Set(['C2025R3PANSTARRS']));
  });

  it('rescans a source linked before overrides were stored (NULL column) exactly as before', () => {
    const root = cometTree();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    db.prepare('UPDATE librarySources SET overrides = NULL WHERE id = ?').run(sourceId);
    expect(rescanSource(sourceId, SETTINGS)).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
  });

  it('moves files a previous scan filed under per-session objects onto the shared object on the next rescan', () => {
    const root = cometTree();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x' });
    // A link made before Dwarf session folders folded together: one object per session folder.
    db.prepare("UPDATE libraryFiles SET objectId = 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385' WHERE sourceId = ? AND relPath LIKE ?")
      .run(sourceId, `%${COMET_15}%`);

    const rescan = rescanSource(sourceId, SETTINGS);
    expect(rescan.updated).toBe(1);
    expect(new Set(objectOf(sourceId).map(r => r.objectId))).toEqual(new Set(['C2025R3PANSTARRS']));
  });
});
