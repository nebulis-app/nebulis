import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Own DATA_DIR so this file never shares appSettings with a concurrent run.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archiveuntyped-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import db from '../../server/lib/db';
import {
  ArchiveConfigError,
  DEFAULT_ARCHIVE_CONFIG,
  getArchiveConfig,
  setArchiveConfig,
} from '../../server/lib/archive/archiveConfig';

// setArchiveConfig is called straight with a request body (Record<string, unknown>).
// These tests pin the runtime checks on that untyped path: unknown keys refused,
// wrong value types refused (never coerced), and a refused patch writes nothing.

/** Call with a body exactly as a route would hand it over. */
function patch(body: Record<string, unknown>): void {
  setArchiveConfig(body);
}

function fieldOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ArchiveConfigError) return err.field;
    throw err;
  }
  return '(no error)';
}

beforeEach(() => {
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
});

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('setArchiveConfig with an untyped record', () => {
  it('applies a well-formed body', () => {
    patch({ path: '/Volumes/Archive', scheduleHour: 4, includeSubframes: true });

    const cfg = getArchiveConfig();
    expect(cfg.path).toBe('/Volumes/Archive');
    expect(cfg.scheduleHour).toBe(4);
    expect(cfg.includeSubframes).toBe(true);
  });

  it('refuses an unknown top-level key and names it', () => {
    expect(fieldOf(() => patch({ archivePath: '/x' }))).toBe('archivePath');
    expect(() => patch({ dropTables: true })).toThrow('unknown archive setting "dropTables"');
  });

  it('writes nothing when any key in the body is refused', () => {
    expect(() => patch({ path: '/Volumes/New', bogus: 1 })).toThrow(ArchiveConfigError);
    expect(getArchiveConfig().path).toBe(DEFAULT_ARCHIVE_CONFIG.path);
  });

  it('treats an undefined value as "not provided"', () => {
    patch({ path: '/Volumes/Keep' });
    patch({ path: undefined, scheduleHour: 6 });
    expect(getArchiveConfig().path).toBe('/Volumes/Keep');
  });

  it.each([
    ['path', 42],
    ['archiveId', null],
    ['lastResult', { ok: true }],
    ['scheduleCron', 5],
  ])('refuses a non-string %s', (key, value) => {
    expect(fieldOf(() => patch({ [key]: value }))).toBe(key);
  });

  it.each([
    ['enabled', 'true'],
    ['scheduleEnabled', 1],
    ['removeLocalAfter', 'false'],
    ['copyMinAgeEnabled', null],
  ])('refuses a non-boolean %s rather than coercing it', (key, value) => {
    expect(fieldOf(() => patch({ [key]: value }))).toBe(key);
  });

  it.each([
    ['scheduleHour', '4'],
    ['scheduleMinute', 1.5],
    ['scheduleIntervalHours', 0],
    ['retentionDays', '30'],
  ])('refuses a non-integer or out-of-range %s', (key, value) => {
    expect(fieldOf(() => patch({ [key]: value }))).toBe(key);
  });

  it('refuses locationType, scope, and scheduleMode outside their unions', () => {
    expect(fieldOf(() => patch({ locationType: 'cloud' }))).toBe('locationType');
    expect(fieldOf(() => patch({ scope: 1 }))).toBe('scope');
    expect(fieldOf(() => patch({ scheduleMode: 'weekly' }))).toBe('scheduleMode');
  });

  it('refuses a selection containing an empty id or a non-string', () => {
    expect(fieldOf(() => patch({ selectedObjects: ['M31', ''] }))).toBe('selectedObjects');
    expect(fieldOf(() => patch({ selectedObjects: 'M31' }))).toBe('selectedObjects');
  });
});

describe('setArchiveConfig network sub-object from an untyped record', () => {
  it('refuses a network value that is not an object', () => {
    expect(fieldOf(() => patch({ network: 'nas' }))).toBe('network');
    expect(fieldOf(() => patch({ network: null }))).toBe('network');
    expect(fieldOf(() => patch({ network: ['host'] }))).toBe('network');
  });

  it('refuses an unknown network key and a non-string network field', () => {
    expect(fieldOf(() => patch({ network: { port: '445' } }))).toBe('network.port');
    expect(fieldOf(() => patch({ network: { host: 10 } }))).toBe('network.host');
  });

  it('refuses a non-boolean clearPassword', () => {
    expect(fieldOf(() => patch({ network: { clearPassword: 'yes' } }))).toBe('network.clearPassword');
  });

  it('ignores hasPassword so a config read can be sent back unchanged', () => {
    patch({ network: { host: 'nas.local', share: 'archive', hasPassword: true } });
    const cfg = getArchiveConfig();
    expect(cfg.network.host).toBe('nas.local');
    expect(cfg.network.hasPassword).toBe(false);
  });

  it('refuses switching to a network destination with no host stored', () => {
    expect(fieldOf(() => patch({ locationType: 'network' }))).toBe('network.host');
  });
});
