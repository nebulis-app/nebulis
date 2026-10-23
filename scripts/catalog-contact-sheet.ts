#!/usr/bin/env tsx
/**
 * Contact sheets of every picture in the built catalog packs, for the look a
 * person has to give them before a release (the automatic checks cannot tell
 * whether the nebula is visible or the right object is in frame).
 *
 *   DRY_RUN=1 npm run catalog:build
 *   npx tsx scripts/catalog-contact-sheet.ts releases/catalog-packs
 *
 * Writes <dir>/sheets/<tier>-01.jpg, ... and sheets/index.html. Each tile shows
 * the picture, its id, its catalog name and which kind of picture it is. Work
 * through the sheets, and for anything wrong use `npm run catalog:pick`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp, { type OverlayOptions } from 'sharp';
import { recordFor } from '../server/lib/dsoCatalogData.js';
import { CATALOG_TIERS } from '../server/lib/catalogPack/manifest.js';
import { resolveCanonicalId } from '../server/lib/catalogAliases.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: catalog-contact-sheet.ts <folder with one subfolder per tier>'); process.exit(1); }

const COLS = 5;
const ROWS = 4;
const TILE_W = 380;
const TILE_H = 253;
const LABEL_H = 34;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Tile { id: string; kind: string; file: string; width: number; height: number }

async function tilesOf(imagesDir: string): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (const file of fs.readdirSync(imagesDir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const hubble = file.startsWith('hubble_');
    const id = hubble ? file.replace(/^hubble_/, '').replace(/\.webp$/, '') : file.replace(/_master\.jpg$/, '');
    const meta = await sharp(path.join(imagesDir, file)).metadata();
    tiles.push({ id: resolveCanonicalId(id), kind: hubble ? 'hubble/pick' : 'sky plate', file: path.join(imagesDir, file), width: meta.width ?? 0, height: meta.height ?? 0 });
  }
  return tiles;
}

async function sheet(tiles: Tile[], out: string): Promise<void> {
  const composites: OverlayOptions[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * TILE_W;
    const y = row * (TILE_H + LABEL_H);
    const picture = await sharp(t.file).resize(TILE_W - 6, TILE_H - 6, { fit: 'inside' }).flatten({ background: '#000' }).jpeg({ quality: 85 }).toBuffer();
    composites.push({ input: picture, left: x + 3, top: y + 3 });
    const record = recordFor(t.id);
    const l1 = `${t.id}  ${record?.name && record.name !== t.id ? record.name : ''}`.slice(0, 44);
    const l2 = `${t.kind}  ${t.width}x${t.height}  ${record?.type ?? ''}${record?.sizeArcmin ? `  ${Math.round(record.sizeArcmin)}'` : ''}`.slice(0, 54);
    const label = `<svg width="${TILE_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#101418"/>`
      + `<text x="4" y="14" font-family="Helvetica,Arial" font-size="13" font-weight="bold" fill="#fff">${esc(l1)}</text>`
      + `<text x="4" y="29" font-family="Helvetica,Arial" font-size="11" fill="#9ab">${esc(l2)}</text></svg>`;
    composites.push({ input: Buffer.from(label), left: x, top: y + TILE_H });
  }
  const used = Math.ceil(tiles.length / COLS);
  await sharp({ create: { width: COLS * TILE_W, height: used * (TILE_H + LABEL_H), channels: 3, background: '#1b1f24' } })
    .composite(composites).jpeg({ quality: 82 }).toFile(out);
}

const outDir = path.join(dir, 'sheets');
fs.mkdirSync(outDir, { recursive: true });
const indexRows: string[] = [];
for (const tier of CATALOG_TIERS) {
  const tierDir = path.join(dir, tier);
  const archive = fs.existsSync(tierDir) ? fs.readdirSync(tierDir).find(f => f.endsWith('.tar.gz')) : undefined;
  if (!archive) { console.log(`${tier}: no archive, skipped`); continue; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `nebulis-sheet-${tier}-`));
  try {
    execFileSync('tar', ['-xzf', path.join(tierDir, archive), '-C', work]);
    const tiles = await tilesOf(path.join(work, 'images'));
    const per = COLS * ROWS;
    for (let n = 0; n * per < tiles.length; n++) {
      const name = `${tier}-${String(n + 1).padStart(2, '0')}.jpg`;
      await sheet(tiles.slice(n * per, (n + 1) * per), path.join(outDir, name));
      indexRows.push(`<h2>${tier} ${n + 1}</h2><img src="${name}" style="max-width:100%">`);
    }
    console.log(`${tier}: ${tiles.length} pictures on ${Math.ceil(tiles.length / per)} sheet(s)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Catalog pack pictures</title><body style="background:#111;color:#ddd;font-family:sans-serif">${indexRows.join('\n')}</body>`);
console.log(`Open ${path.join(outDir, 'index.html')}`);
