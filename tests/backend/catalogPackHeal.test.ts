/**
 * Stale Hubble master detection and thumbnail purge (server/lib/catalogPack/heal.ts).
 *
 * The regression behind it: an old scraper wrote the Crab Nebula over seven
 * open clusters, and the installer's no-overwrite guard kept those files
 * through every later pack install.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findStaleHubbleMasters,
  localHubbleMasterPath,
  purgeResizedThumbnails,
} from '../../server/lib/catalogPack/heal';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let skyCache: string;

beforeEach(() => {
  skyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-heal-'));
});
afterEach(() => {
  fs.rmSync(skyCache, { recursive: true, force: true });
});

describe('localHubbleMasterPath', () => {
  it('maps a pack hubble image to its sky-cache file', () => {
    expect(localHubbleMasterPath(skyCache, 'images/hubble_M44.webp')).toBe(path.join(skyCache, 'hubble_M44.webp'));
  });

  it('ignores every other pack file', () => {
    expect(localHubbleMasterPath(skyCache, 'images/M44_master.jpg')).toBeNull();
    expect(localHubbleMasterPath(skyCache, 'descriptions.json')).toBeNull();
  });
});

describe('findStaleHubbleMasters', () => {
  it('flags a local master whose hash differs from the manifest', () => {
    fs.writeFileSync(path.join(skyCache, 'hubble_M44.webp'), 'crab');
    const stale = findStaleHubbleMasters([{ path: 'images/hubble_M44.webp', sha256: sha('beehive') }], skyCache);
    expect(stale).toEqual(['images/hubble_M44.webp']);
  });

  it('leaves a matching master alone', () => {
    fs.writeFileSync(path.join(skyCache, 'hubble_M44.webp'), 'beehive');
    expect(findStaleHubbleMasters([{ path: 'images/hubble_M44.webp', sha256: sha('beehive') }], skyCache)).toEqual([]);
  });

  it('does not treat a missing master as stale', () => {
    expect(findStaleHubbleMasters([{ path: 'images/hubble_M44.webp', sha256: sha('beehive') }], skyCache)).toEqual([]);
  });

  it('only looks at hubble masters, not DSS2 plates', () => {
    fs.writeFileSync(path.join(skyCache, 'M44_master.jpg'), 'different');
    expect(findStaleHubbleMasters([{ path: 'images/M44_master.jpg', sha256: sha('beehive') }], skyCache)).toEqual([]);
  });
});

describe('purgeResizedThumbnails', () => {
  it('removes one object and source, leaving other sources, sizes and objects', () => {
    const resized = path.join(skyCache, 'resized');
    fs.mkdirSync(resized);
    const names = [
      'M44_hubble_384x384.jpg', 'M44_hubble_1920x1080_cover.jpg',
      'M44_dss2_384x384.jpg', 'M4_hubble_384x384.jpg', 'M445_hubble_384x384.jpg',
    ];
    for (const n of names) fs.writeFileSync(path.join(resized, n), 'x');

    expect(purgeResizedThumbnails(skyCache, 'M44', 'hubble')).toBe(2);
    expect(fs.readdirSync(resized).sort()).toEqual(
      ['M44_dss2_384x384.jpg', 'M445_hubble_384x384.jpg', 'M4_hubble_384x384.jpg'].sort(),
    );
  });

  it('returns 0 when there is no resized directory', () => {
    expect(purgeResizedThumbnails(skyCache, 'M44', 'hubble')).toBe(0);
  });
});
