import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { assembleImages, archiveNameFor, type AssemblyContext, type Candidate } from '../../server/lib/catalogPack/tierAssembly';
import { loadOverrides, saveOverrides, type OverrideEntry } from '../../server/lib/catalogPack/imageOverrides';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-assembly-')); fs.mkdirSync(path.join(dir, 'files')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function picture(name: string, seed: string, opts: { w?: number; h?: number; hole?: boolean; ext?: 'jpg' | 'webp' } = {}): Promise<string> {
  const w = opts.w ?? 900;
  const h = opts.h ?? 650;
  const buf = Buffer.alloc(w * h * 3);
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  for (let i = 0; i < buf.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; buf[i] = 20 + (state % 60); }
  if (opts.hole) for (let y = 0; y < 250; y++) for (let x = 0; x < 300; x++) { const i = (y * w + x) * 3; buf[i] = buf[i + 1] = buf[i + 2] = 0; }
  const file = path.join(dir, name);
  const img = sharp(buf, { raw: { width: w, height: h, channels: 3 } });
  await (opts.ext === 'webp' ? img.webp({ lossless: true }) : img.jpeg({ quality: 95 })).toFile(file);
  return file;
}

function ctx(overrides: Map<string, OverrideEntry> = new Map()): AssemblyContext {
  saveOverrides(overrides, dir);
  return { tier: 'messier', overrides: loadOverrides(dir), signatures: new Map(), blackBackground: new Set(), report: [], ocr: false };
}

const rows = (c: AssemblyContext) => c.report.map(r => `${r.id}:${r.kind}:${r.action}`);

describe('assembleImages', () => {
  it('ships a clean picture under the name the installer reads', async () => {
    const c = ctx();
    const cands: Candidate[] = [
      { id: 'M1', kind: 'hubble', src: await picture('m1.webp', 'm1', { ext: 'webp' }) },
      { id: 'M1', kind: 'dss2', src: await picture('m1.jpg', 'm1-sky') },
    ];
    const out = await assembleImages(cands, new Set(['M1']), c);
    expect(out.map(o => o.archiveName).sort()).toEqual(['M1_master.jpg', 'hubble_M1.webp']);
  });

  it('keeps a picture with a mosaic hole out of the pack', async () => {
    const c = ctx();
    const out = await assembleImages([{ id: 'M65', kind: 'hubble', src: await picture('m65.webp', 'm65', { hole: true, ext: 'webp' }) }], new Set(['M65']), c);
    expect(out).toEqual([]);
    expect(rows(c)).toEqual(['M65:hubble:dropped']);
    expect(c.report[0].problems).toContain('notch');
  });

  it('ships it when a person waived the problem', async () => {
    const c = ctx(new Map([['NGC2392', { waive: ['notch'] }]]));
    const out = await assembleImages([{ id: 'NGC2392', kind: 'hubble', src: await picture('eskimo.webp', 'eskimo', { hole: true, ext: 'webp' }) }], new Set(['NGC2392']), c);
    expect(out.length).toBe(1);
  });

  it('keeps the first of two objects with the same picture and drops the second', async () => {
    const c = ctx();
    const a = await picture('a.webp', 'same', { ext: 'webp' });
    const b = await picture('b.webp', 'same', { ext: 'webp' });
    const out = await assembleImages([{ id: 'NGC188', kind: 'hubble', src: a }, { id: 'NGC3115', kind: 'hubble', src: b }], new Set(['NGC188', 'NGC3115']), c);
    expect(out.map(o => o.objectId)).toEqual(['NGC188']);
    expect(c.report.find(r => r.id === 'NGC3115')?.problems).toContain('duplicate');
  });

  it('replaces the scraped Hubble picture with a hand-picked one and keeps the sky plate', async () => {
    const file = await picture('files/IC63.webp', 'pick', { ext: 'webp' });
    expect(fs.existsSync(file)).toBe(true);
    const c = ctx(new Map([['IC63', { image: { file: 'IC63.webp', credit: 'ESA/Hubble & NASA', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://esahubble.org/images/x/' } }]]));
    const out = await assembleImages([
      { id: 'IC63', kind: 'hubble', src: await picture('scraped.webp', 'scraped', { ext: 'webp' }) },
      { id: 'IC63', kind: 'dss2', src: await picture('plate.jpg', 'plate') },
    ], new Set(['IC63']), c);
    expect(out.map(o => `${o.source}:${o.archiveName}`).sort()).toEqual(['curated:hubble_IC63.webp', 'dss2:IC63_master.jpg']);
    expect(rows(c)).toContain('IC63:hubble:dropped');
    expect(rows(c)).toContain('IC63:curated:replaced');
  });

  it('adds a hand-picked picture for an object that had no scraped one', async () => {
    await picture('files/IC2602.webp', 'pleiades-south', { ext: 'webp' });
    const c = ctx(new Map([['IC2602', { image: { file: 'IC2602.webp', credit: 'ESO', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://eso.org/public/images/x/' } }]]));
    const out = await assembleImages([], new Set(['IC2602']), c);
    expect(out.map(o => o.archiveName)).toEqual(['hubble_IC2602.webp']);
  });

  it('honours drop overrides for either kind of picture', async () => {
    const c = ctx(new Map<string, OverrideEntry>([['M44', { hubble: 'drop' }], ['SH2-17', { dss2: 'drop' }]]));
    const out = await assembleImages([
      { id: 'M44', kind: 'hubble', src: await picture('m44.webp', 'm44', { ext: 'webp' }) },
      { id: 'M44', kind: 'dss2', src: await picture('m44.jpg', 'm44-sky') },
      { id: 'SH2-17', kind: 'dss2', src: await picture('sh17.jpg', 'sh17') },
    ], new Set(['M44', 'SH2-17']), c);
    expect(out.map(o => o.archiveName)).toEqual(['M44_master.jpg']);
  });

  it('ignores a candidate for an object this tier does not own', async () => {
    const c = ctx();
    const out = await assembleImages([{ id: 'M8', kind: 'dss2', src: await picture('m8.jpg', 'm8') }], new Set(['M1']), c);
    expect(out).toEqual([]);
  });

  it('refuses a hand-picked picture that fails the checks, so a bad pick cannot ship quietly', async () => {
    await picture('files/BAD.webp', 'bad', { hole: true, ext: 'webp' });
    const c = ctx(new Map([['IC63', { image: { file: 'BAD.webp', credit: 'ESA/Hubble & NASA', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://esahubble.org/images/x/' } }]]));
    await expect(assembleImages([], new Set(['IC63']), c)).rejects.toThrow(/IC63.*notch/);
  });
});

describe('archiveNameFor', () => {
  it('uses the installer naming for each kind', () => {
    expect(archiveNameFor('M1', 'hubble')).toBe('hubble_M1.webp');
    expect(archiveNameFor('M1', 'curated')).toBe('hubble_M1.webp');
    expect(archiveNameFor('SH2-190', 'dss2')).toBe('SH2-190_master.jpg');
    expect(archiveNameFor('Sun', 'nasa')).toBe('SUN_master.jpg');
  });
});
