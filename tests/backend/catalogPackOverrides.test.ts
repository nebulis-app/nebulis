import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverrides, saveOverrides, validateOverrides, loadNeedsPick, type OverrideEntry } from '../../server/lib/catalogPack/imageOverrides';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-overrides-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const picked = (file: string): OverrideEntry => ({
  image: { file, credit: 'ESA/Hubble & NASA', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://esahubble.org/images/heic0000a/' },
});

describe('overrides file', () => {
  it('is empty when nothing has been picked yet', () => {
    expect(loadOverrides(dir).entries.size).toBe(0);
  });

  it('round-trips with keys in catalog order', () => {
    saveOverrides(new Map<string, OverrideEntry>([['NGC253', { hubble: 'drop' }], ['IC63', { dss2: { fovArcmin: 40 } }], ['M44', { waive: ['notch'], note: 'ok' }]]), dir);
    const back = loadOverrides(dir);
    expect([...back.entries.keys()]).toEqual(['IC63', 'M44', 'NGC253']);
    expect(back.entries.get('IC63')).toEqual({ dss2: { fovArcmin: 40 } });
  });

  it('takes a survey choice for the sky plate, with or without a width', () => {
    saveOverrides(new Map<string, OverrideEntry>([['SH2-31', { dss2: { survey: 'dss2' } }], ['SH2-12', { dss2: { survey: 'vphas', fovArcmin: 200 } }]]), dir);
    const back = loadOverrides(dir);
    expect(back.entries.get('SH2-31')).toEqual({ dss2: { survey: 'dss2' } });
    expect(back.entries.get('SH2-12')).toEqual({ dss2: { survey: 'vphas', fovArcmin: 200 } });
  });

  it('rejects a sky-plate override that says nothing', () => {
    fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify({ version: 1, entries: { 'SH2-31': { dss2: {} } } }));
    expect(() => loadOverrides(dir)).toThrow();
  });

  it('rejects an entry with a bad credit or url when loading', () => {
    fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify({ version: 1, entries: { IC63: { image: { file: 'IC63.webp', credit: 'x', licenseUrl: 'nope', sourceUrl: 'nope' } } } }));
    expect(() => loadOverrides(dir)).toThrow();
  });

  it('rejects a picture file name that could leave the folder', () => {
    fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify({ version: 1, entries: { IC63: { ...picked('../x.webp') } } }));
    expect(() => loadOverrides(dir)).toThrow();
  });
});

describe('validateOverrides', () => {
  it('flags a missing picture, a non-canonical id, a clash and an unused file', () => {
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'files', 'stray.webp'), 'x');
    saveOverrides(new Map<string, OverrideEntry>([
      ['IC63', picked('IC63.webp')],
      ['C102', { hubble: 'drop' }],
      ['M31', { ...picked('M31.webp'), hubble: 'drop' }],
    ]), dir);
    fs.writeFileSync(path.join(dir, 'files', 'M31.webp'), 'x');
    const problems = validateOverrides(loadOverrides(dir));
    expect(problems.some(p => p.startsWith('IC63') && p.includes('missing'))).toBe(true);
    expect(problems.some(p => p.startsWith('C102') && p.includes('IC2602'))).toBe(true);
    expect(problems.some(p => p.startsWith('M31') && p.includes('both'))).toBe(true);
    expect(problems.some(p => p.includes('stray.webp'))).toBe(true);
  });

  it('accepts a clean set', () => {
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'files', 'IC63.webp'), 'x');
    saveOverrides(new Map<string, OverrideEntry>([['IC63', picked('IC63.webp')]]), dir);
    expect(validateOverrides(loadOverrides(dir))).toEqual([]);
  });
});

describe('the overrides shipped in the repo', () => {
  it('are valid, and the needs-pick list is well formed', () => {
    expect(validateOverrides(loadOverrides())).toEqual([]);
    for (const row of loadNeedsPick()) expect(row.reason.length).toBeGreaterThan(3);
  });
});
