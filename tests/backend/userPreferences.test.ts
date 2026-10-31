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
  getWatermarkPresets, setWatermarkPresets, getLastSeenVersion, setLastSeenVersion,
  WatermarkPresetsBodySchema, type WatermarkPreset,
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

  /**
   * The read path DROPS anything that fails the schema. A required geometry
   * field would therefore delete every preset saved before the watermarks
   * feature on the next read. This row is spelled out as the pre-feature JSON
   * rather than built by the factory so the guard survives a factory change.
   */
  it('returns a preset stored before the geometry fields existed', () => {
    const legacy = {
      id: 'old', name: 'Bottom right', text: '© 2024 Me', fontSize: 36,
      fontFamily: 'Arial, sans-serif', color: '#ffffff', bold: false, italic: false,
      opacity: 70, align: 'right', angle: 0,
    };
    db.prepare('INSERT INTO userPreferences (userId, watermarkPresets) VALUES (?, ?)')
      .run('u1', JSON.stringify([legacy]));
    expect(getWatermarkPresets('u1')).toEqual([legacy]);
  });

  it('round-trips the geometry the image editor saves', () => {
    const saved = preset('geo', { name: 'Corner', sizePct: 0.035, x: 0.97, y: 0.94, opacity: 70 });
    setWatermarkPresets('u1', [saved]);
    expect(getWatermarkPresets('u1')).toEqual([saved]);
  });

  it('saving presets leaves lastSeenVersion alone, and the reverse', () => {
    setLastSeenVersion('u1', '2.1.0');
    setWatermarkPresets('u1', [preset('a')]);
    expect(getLastSeenVersion('u1')).toBe('2.1.0');
    setLastSeenVersion('u1', '2.1.2');
    expect(getWatermarkPresets('u1').map(p => p.id)).toEqual(['a']);
  });
});

describe('WatermarkPresetsBodySchema', () => {
  // The editor stores opacity on the 0–100 scale; the read fixture above uses
  // the old fractional value, which the write schema still accepts as a number.
  const input = (over: Partial<WatermarkPreset> = {}): WatermarkPreset =>
    preset('a', { name: 'Mark A', opacity: 70, ...over });

  it('accepts a pre-geometry payload from an older client', () => {
    expect(WatermarkPresetsBodySchema.safeParse([input()]).success).toBe(true);
  });

  it('accepts a payload with geometry', () => {
    const parsed = WatermarkPresetsBodySchema.safeParse([input({ sizePct: 0.05, x: 0.2, y: 0.8 })]);
    expect(parsed.success).toBe(true);
  });

  it('refuses geometry the renderer could not draw sensibly', () => {
    for (const over of [
      { sizePct: 0 },
      { sizePct: 1.5 },
      { x: -0.01 },
      { y: 1.01 },
      { angle: 100 },
      { opacity: -1 },
      { color: 'white' },
      { name: 'x'.repeat(41) },
      { name: '   ' },
      { text: '' },
      { text: 'x'.repeat(2001) },
    ]) {
      expect(WatermarkPresetsBodySchema.safeParse([input(over as Partial<WatermarkPreset>)]).success, JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses duplicate names, case-insensitively, and duplicate ids', () => {
    expect(WatermarkPresetsBodySchema.safeParse([
      input({ id: 'a', name: 'Corner' }),
      input({ id: 'b', name: '  corner ' }),
    ]).success).toBe(false);
    expect(WatermarkPresetsBodySchema.safeParse([
      input({ id: 'a', name: 'Corner  mark' }),
      input({ id: 'b', name: 'corner mark' }),
    ]).success).toBe(false);
    expect(WatermarkPresetsBodySchema.safeParse([
      input({ id: 'same', name: 'One' }),
      input({ id: 'same', name: 'Two' }),
    ]).success).toBe(false);
  });

  it('refuses more than 50 presets', () => {
    const many = Array.from({ length: 51 }, (_, i) => input({ id: `p${i}`, name: `Mark ${i}` }));
    expect(WatermarkPresetsBodySchema.safeParse(many).success).toBe(false);
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
