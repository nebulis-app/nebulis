import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-userprefs-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import {
  getWatermarkPresets, setWatermarkPresets, getLastSeenVersion, setLastSeenVersion, type WatermarkPreset,
} from '../../server/lib/userPreferences';

const preset = (id: string, over: Partial<WatermarkPreset> = {}): WatermarkPreset => ({
  id, name: `Preset ${id}`, text: '© Me', fontSize: 24, fontFamily: 'sans-serif', color: '#ffffff',
  bold: false, italic: false, opacity: 0.6, align: 'right', angle: 0, ...over,
});

beforeEach(() => {
  db.prepare('DELETE FROM userPreferences').run();
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('watermark presets', () => {
  it('is empty for a user who never saved any', () => {
    expect(getWatermarkPresets('nobody')).toEqual([]);
  });

  it('round-trips and replaces the previous value', () => {
    setWatermarkPresets('u1', [preset('a'), preset('b')]);
    expect(getWatermarkPresets('u1').map(p => p.id)).toEqual(['a', 'b']);
    setWatermarkPresets('u1', [preset('c', { bold: true, align: 'left' })]);
    expect(getWatermarkPresets('u1')).toEqual([preset('c', { bold: true, align: 'left' })]);
  });

  it('keeps users separate', () => {
    setWatermarkPresets('u1', [preset('a')]);
    setWatermarkPresets('u2', [preset('b')]);
    expect(getWatermarkPresets('u1').map(p => p.id)).toEqual(['a']);
    expect(getWatermarkPresets('u2').map(p => p.id)).toEqual(['b']);
  });

  it('drops stored entries that no longer match the schema', () => {
    db.prepare('INSERT INTO userPreferences (userId, watermarkPresets) VALUES (?, ?)')
      .run('u1', JSON.stringify([preset('ok'), { id: 'bad' }, 'junk', null, preset('wrong-align', { align: 'middle' as never })]));
    expect(getWatermarkPresets('u1').map(p => p.id)).toEqual(['ok']);
  });

  it('returns an empty list when the stored JSON is not an array', () => {
    db.prepare('INSERT INTO userPreferences (userId, watermarkPresets) VALUES (?, ?)').run('u1', '{"a":1}');
    expect(getWatermarkPresets('u1')).toEqual([]);
  });

  it('saving presets leaves lastSeenVersion alone, and the reverse', () => {
    setLastSeenVersion('u1', '2.1.0');
    setWatermarkPresets('u1', [preset('a')]);
    expect(getLastSeenVersion('u1')).toBe('2.1.0');
    setLastSeenVersion('u1', '2.1.2');
    expect(getWatermarkPresets('u1').map(p => p.id)).toEqual(['a']);
  });
});

describe('lastSeenVersion', () => {
  it('is null until the user acknowledges a version', () => {
    expect(getLastSeenVersion('u1')).toBeNull();
  });

  it('stores, updates, and is idempotent', () => {
    setLastSeenVersion('u1', '2.1.1');
    setLastSeenVersion('u1', '2.1.1');
    expect(getLastSeenVersion('u1')).toBe('2.1.1');
    setLastSeenVersion('u1', '2.1.2');
    expect(getLastSeenVersion('u1')).toBe('2.1.2');
    expect(db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM userPreferences WHERE userId = ?').get('u1')!.c).toBe(1);
  });
});
