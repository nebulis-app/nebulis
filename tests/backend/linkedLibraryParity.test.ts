import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedparity-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { scanImportFolder } from '../../server/lib/library/folderScan';
import { scanSource, commitSource, rescanSource } from '../../server/lib/library/librarySources';
import { getStartrailsObjectId, STARTRAILS_TARGET_NAME } from '../../server/lib/library/dwarfStartrails';

// No thumbnails, no videos, sub-frames on (the Dwarf raw FITS are the observations here). The same object
// goes to both scanners.
const SETTINGS = { importJpg: true, importFits: true, importThumbnails: false, importVideos: false, importSubFrames: true };
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

const CAP_A = 'STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-05-00-22-28-967';
const CAP_B = 'STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-16-21-57-44-922';

/** A Dwarf card as it comes off the device: two sessions of one uncatalogued comet, one catalogued
 *  target, Star Trails captures with a per-frame Thumbnail folder, and the folders that hold no
 *  observations. Every observation file carries its date in its own name, so both scanners have the same
 *  unambiguous signal to bucket by. */
function dwarfCard(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-parity-card-'));
  roots.push(root);
  const put = (rel: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x'.repeat(64));
  };
  put('DWARF_RAW_TELE_C 2025 R3 PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385/C 2025 R3 PANSTARRS_15s60_Astro_20260415-063816385_26C.fits');
  put('DWARF_RAW_TELE_C 2025 R3 PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383/C 2025 R3 PANSTARRS_30s60_Astro_20260416-062117383_26C.fits');
  put('DWARF_RAW_TELE_IC 1396_EXP_60_GAIN_60_2026-04-15-00-59-00-467/IC 1396_60s60_Astro_20260415-005900467_26C.fits');
  put('DWARF_RAW_TELE_IC 1396_EXP_60_GAIN_60_2026-07-04-22-54-04-623/IC 1396_60s60_Astro_20260704-225404623_26C.fits');
  for (const [cap, stamp] of [[CAP_A, '20260405-0022'], [CAP_B, '20260416-2158']] as const) {
    for (let i = 0; i < 3; i++) {
      put(`STARTRAILS/${cap}/startrails_10s0_${stamp}${10 + i}000_24C.fits`);
      // Per-frame previews live in Thumbnail/ and say nothing about being previews in their names.
      put(`STARTRAILS/${cap}/Thumbnail/startrails_10s0_${stamp}${10 + i}000_24C.jpg`);
    }
  }
  put('CALI_FRAME/dark_20260101-000000.fits');
  put('RESTACKED/M 31/Stacked_10_M 31_10.0s_IRCUT_20260101-200000.fits');
  return root;
}

const norm = (id: string) => id.replace(/\s+/g, '').toLowerCase();
const summarize = (rows: Array<{ id: string; fileCount: number; sessions: Array<{ date: string; fileCount: number }> }>) =>
  rows
    .map(r => `${norm(r.id)} ${r.fileCount} ${r.sessions.map(s => `${s.date}(${s.fileCount})`).sort().join(' ')}`)
    .sort();

describe('link and copy import read the same folder the same way', () => {
  it('find the same objects, the same file counts and the same session dates', () => {
    const root = dwarfCard();
    const copy = scanImportFolder(root, SETTINGS);
    const link = scanSource(root, SETTINGS);

    const copyRows = summarize(copy.objects.map(o => ({ id: o.targetObjectId ?? o.folderName, fileCount: o.fileCount, sessions: o.sessions })));
    const linkRows = summarize(link.objects.map(o => ({ id: o.objectId, fileCount: o.fileCount, sessions: o.sessions })));
    expect(linkRows).toEqual(copyRows);
    // Not vacuous: the card really does hold all four objects.
    expect(linkRows).toHaveLength(3);
    expect(linkRows.map(r => r.split(' ')[0]).sort()).toEqual(['c2025r3panstarrs', 'dwarfstartrails', 'ic1396']);
  });

  it('agree on Star Trails specifically: both captures, frames only, no per-frame previews', () => {
    const root = dwarfCard();
    const link = scanSource(root, SETTINGS);
    const trails = link.objects.find(o => o.objectId === getStartrailsObjectId());
    expect(trails).toBeDefined();
    expect(trails!.fileCount).toBe(6); // 2 captures x 3 frames; the 6 Thumbnail/ previews stay out
    expect(trails!.sessions.map(s => s.date).sort()).toEqual(['2026-04-05', '2026-04-16']);
    // Named for what it is, so the review screen does not read "no catalog match" beside it.
    expect(trails!.catalogMatch).toMatchObject({ name: STARTRAILS_TARGET_NAME, type: 'Star Trails' });
    expect(link.unresolved).toEqual([]);
  });

  it('date a Star Trails capture by its folder name, not by when the files were copied', () => {
    const root = dwarfCard();
    // A card copied to a new disk: every file now claims to be from years ago (or, in real life, from today).
    const longAgo = new Date('2001-01-01T12:00:00Z');
    const stamp = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) stamp(abs); else fs.utimesSync(abs, longAgo, longAgo);
      }
    };
    stamp(root);

    const copy = scanImportFolder(root, SETTINGS).objects.find(o => norm(o.targetObjectId ?? o.folderName) === 'dwarfstartrails');
    const link = scanSource(root, SETTINGS).objects.find(o => o.objectId === getStartrailsObjectId());
    const dates = (xs: Array<{ date: string }> | undefined) => (xs ?? []).map(s => s.date).sort();
    expect(dates(copy?.sessions)).toEqual(['2026-04-05', '2026-04-16']);
    expect(dates(link?.sessions)).toEqual(['2026-04-05', '2026-04-16']);
  });

  it('name the same excluded folders and account for skipped files in the same words', () => {
    const root = dwarfCard();
    const copy = scanImportFolder(root, SETTINGS);
    const link = scanSource(root, SETTINGS);
    expect(link.excludedFolders).toEqual(copy.excludedFolders);
    expect(link.excludedFolders).toEqual(['CALI_FRAME', 'RESTACKED']);

    const folders = link.skipped.find(s => s.reason === 'non-observation-folder');
    expect(folders?.count).toBe(2);
    expect(folders?.samples).toEqual(['CALI_FRAME', 'RESTACKED']);
    expect(folders?.label).toBe(copy.skipped.find(s => s.reason === 'non-observation-folder')?.label);
  });

  it('report the folder each object came from, and where each session date came from', () => {
    const root = dwarfCard();
    const link = scanSource(root, SETTINGS);
    const byId = new Map(link.objects.map(o => [norm(o.objectId), o]));
    expect(byId.get('c2025r3panstarrs')?.sourceName).toBe('C 2025 R3 PANSTARRS');
    expect(byId.get('ic1396')?.sourceName).toBe('IC 1396');
    expect(byId.get('dwarfstartrails')?.sourceName).toBe('STARTRAILS');
    // The comet's files carry their date in the name; the Star Trails frames only have their capture folder.
    expect(byId.get('c2025r3panstarrs')?.sessions.every(s => s.source === 'filename')).toBe(true);
    expect(byId.get('dwarfstartrails')?.sessions.every(s => s.source === 'folder')).toBe(true);
  });

  it('leave the same folders out', () => {
    const root = dwarfCard();
    const link = scanSource(root, SETTINGS);
    // CALI_FRAME and RESTACKED hold no observations for either path.
    expect(link.objects.some(o => norm(o.objectId) === 'm31')).toBe(false);
    expect(link.objects.some(o => o.objectId.toLowerCase().includes('dark'))).toBe(false);
  });
});

describe('linking Star Trails', () => {
  it('creates the shared object with its curated name and type, not a placeholder', () => {
    const root = dwarfCard();
    commitSource(root, SETTINGS, { label: 'card' });

    const row = db.prepare<[string], { objectName: string; objectType: string; constellation: string; description: string }>(
      'SELECT objectName, objectType, constellation, description FROM libraryObjects WHERE objectId = ?',
    ).get(getStartrailsObjectId());
    expect(row?.objectName).toBe(STARTRAILS_TARGET_NAME);
    expect(row?.objectType).toBe('Star Trails');
    expect(row?.constellation).toBe('');
    expect(row?.description).toMatch(/Star Trails captures show/);
  });

  it('links only the frames, across both nights, as one object', () => {
    const root = dwarfCard();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'card' });
    const rows = db.prepare<[string, string], { relPath: string }>(
      'SELECT relPath FROM libraryFiles WHERE sourceId = ? AND objectId = ?',
    ).all(sourceId, getStartrailsObjectId());
    expect(rows).toHaveLength(6);
    expect(rows.every(r => !/thumbnail/i.test(r.relPath))).toBe(true);
    const sessions = db.prepare<[string], { captureDate: string }>(
      'SELECT DISTINCT captureDate FROM libraryFiles WHERE sourceId = ? AND captureDate IS NOT NULL',
    ).all(sourceId);
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('heals the curated name after a rescan, and reports nothing changed', () => {
    const root = dwarfCard();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'card' });
    db.prepare('UPDATE libraryObjects SET objectName = objectId, objectType = NULL WHERE objectId = ?').run(getStartrailsObjectId());

    const rescan = rescanSource(sourceId, SETTINGS);
    expect(rescan).toMatchObject({ added: 0, updated: 0, missing: 0, removed: 0 });
    const row = db.prepare<[string], { objectName: string; objectType: string }>(
      'SELECT objectName, objectType FROM libraryObjects WHERE objectId = ?',
    ).get(getStartrailsObjectId());
    expect(row).toMatchObject({ objectName: STARTRAILS_TARGET_NAME, objectType: 'Star Trails' });
  });
});
