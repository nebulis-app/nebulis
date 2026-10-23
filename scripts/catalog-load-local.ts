#!/usr/bin/env tsx
/**
 * Load a locally built catalog pack into a dev instance, to see how it looks.
 *
 *   DRY_RUN=1 npm run catalog:build                      # builds releases/catalog-packs, uploads nothing
 *   npx tsx scripts/catalog-load-local.ts releases/catalog-packs
 *   NEBULIS_SKIP_PACK_INSTALL=1 npm run dev               # start the server so it keeps them
 *   npx tsx scripts/catalog-load-local.ts --undo          # put everything back
 *
 * Run from the repo root with the server STOPPED (it reads ./data like the dev server does).
 *
 * What it does, per tier archive: copies each picture into data/sky-cache, removes the resized
 * thumbnails of every object it replaces so the new one is served, deletes a stale Hubble picture
 * for an object the new pack has none for (a dropped banner or a hole would otherwise outrank the
 * sky plate), writes the descriptions into catalogCache, and copies credits-<tier>.json.
 *
 * It does NOT touch catalogPackState, and nothing it writes is signed. Without
 * NEBULIS_SKIP_PACK_INSTALL=1 the server's 24-hour update check sees Hubble pictures that differ from
 * the published manifest and reinstalls the published packs over them.
 *
 * Everything it replaces or removes is copied to data/pack-load-backup first, with the old
 * catalogCache rows, so --undo restores the instance exactly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { CATALOG_TIERS } from '../server/lib/catalogPack/manifest.js';
import { purgeResizedThumbnails } from '../server/lib/catalogPack/heal.js';
import { resolveCanonicalId } from '../server/lib/catalogAliases.js';

const DATA = path.join(process.cwd(), 'data');
const SKY = path.join(DATA, 'sky-cache');
const BACKUP = path.join(DATA, 'pack-load-backup');
const LOG = path.join(BACKUP, 'changes.json');

interface Changes {
  loadedAt: string;
  replaced: string[];       // sky-cache files that existed and were backed up
  added: string[];          // sky-cache files that did not exist
  removed: string[];        // stale Hubble files moved to the backup
  credits: string[];        // credits-<tier>.json (replaced or added)
  cacheRows: Array<{ objectId: string; before: Record<string, unknown> | null }>;
}

function openDb(): Database.Database {
  const file = path.join(DATA, 'nebulis.db');
  if (!fs.existsSync(file)) { console.error(`No database at ${file}. Run this from the repo root.`); process.exit(1); }
  return new Database(file);
}

function refuseIfRunning(): void {
  try {
    const out = execFileSync('lsof', ['-t', path.join(DATA, 'nebulis.db')], { encoding: 'utf8' }).trim();
    if (out) { console.error('The server is running (it has the database open). Stop it first.'); process.exit(1); }
  } catch { /* lsof exits 1 when nothing has the file open */ }
}

function undo(): void {
  if (!fs.existsSync(LOG)) { console.error('Nothing to undo: no load has been recorded.'); process.exit(1); }
  const changes = JSON.parse(fs.readFileSync(LOG, 'utf8')) as Changes;
  const db = openDb();
  const restore = (name: string) => {
    const saved = path.join(BACKUP, 'files', name);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(SKY, name));
  };
  for (const name of changes.replaced) restore(name);
  for (const name of changes.removed) restore(name);
  for (const name of changes.added) fs.rmSync(path.join(SKY, name), { force: true });
  for (const name of changes.credits) {
    const saved = path.join(BACKUP, 'files', name);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(SKY, name)); else fs.rmSync(path.join(SKY, name), { force: true });
  }
  const del = db.prepare('DELETE FROM catalogCache WHERE objectId = ?');
  const put = db.prepare('INSERT OR REPLACE INTO catalogCache (objectId, extract, wikiUrl, source, fetchedAt, status) VALUES (@objectId, @extract, @wikiUrl, @source, @fetchedAt, @status)');
  db.transaction(() => {
    for (const row of changes.cacheRows) { if (row.before) put.run(row.before); else del.run(row.objectId); }
  })();
  // The restored pictures are the old ones, so thumbnails made from the new ones must go.
  const ids = new Set([...changes.replaced, ...changes.added, ...changes.removed].map(n => n.replace(/^hubble_/, '').replace(/\.(webp|jpg)$/, '').replace(/_master$/, '')));
  for (const id of ids) { purgeResizedThumbnails(SKY, id, 'hubble'); purgeResizedThumbnails(SKY, id, 'dss2'); }
  fs.renameSync(BACKUP, `${BACKUP}-undone-${Date.now()}`);
  console.log(`Restored ${changes.replaced.length + changes.removed.length} files, removed ${changes.added.length} added ones and reverted ${changes.cacheRows.length} descriptions.`);
}

function load(dir: string): void {
  if (fs.existsSync(LOG)) { console.error('A load is already recorded. Run --undo first, or delete data/pack-load-backup if you are sure.'); process.exit(1); }
  const changes: Changes = { loadedAt: new Date().toISOString(), replaced: [], added: [], removed: [], credits: [], cacheRows: [] };
  fs.mkdirSync(path.join(BACKUP, 'files'), { recursive: true });
  const db = openDb();
  const getRow = db.prepare('SELECT objectId, extract, wikiUrl, source, fetchedAt, status FROM catalogCache WHERE objectId = ?');
  const put = db.prepare(`INSERT INTO catalogCache (objectId, extract, wikiUrl, source, fetchedAt, status) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(objectId) DO UPDATE SET extract = excluded.extract, wikiUrl = excluded.wikiUrl, source = excluded.source, fetchedAt = excluded.fetchedAt, status = excluded.status`);
  const save = (name: string) => {
    const file = path.join(SKY, name);
    if (fs.existsSync(file) && !fs.existsSync(path.join(BACKUP, 'files', name))) fs.copyFileSync(file, path.join(BACKUP, 'files', name));
  };
  const now = new Date().toISOString();
  let loaded = 0;

  for (const tier of CATALOG_TIERS) {
    const tierDir = path.join(dir, tier);
    const archive = fs.existsSync(tierDir) ? fs.readdirSync(tierDir).find(f => f.endsWith('.tar.gz')) : undefined;
    if (!archive) { console.log(`${tier}: no archive, skipped`); continue; }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `nebulis-load-${tier}-`));
    try {
      execFileSync('tar', ['-xzf', path.join(tierDir, archive), '-C', work]);
      const images = fs.readdirSync(path.join(work, 'images'));
      const shipsHubble = new Set(images.filter(f => f.startsWith('hubble_')).map(f => f.replace(/^hubble_/, '').replace(/\.webp$/, '')));

      for (const file of images) {
        const hubble = file.startsWith('hubble_');
        const id = resolveCanonicalId(hubble ? file.replace(/^hubble_/, '').replace(/\.webp$/, '') : file.replace(/_master\.jpg$/, ''));
        const dest = path.join(SKY, file);
        if (fs.existsSync(dest)) { save(file); changes.replaced.push(file); } else changes.added.push(file);
        fs.copyFileSync(path.join(work, 'images', file), dest);
        purgeResizedThumbnails(SKY, id, hubble ? 'hubble' : 'dss2');
        loaded++;
      }
      // An object this pack carries a sky plate for but no Hubble picture: a Hubble file left
      // from the published pack would still outrank the plate, so it goes to the backup.
      for (const file of images.filter(f => f.endsWith('_master.jpg'))) {
        const id = resolveCanonicalId(file.replace(/_master\.jpg$/, ''));
        const stale = `hubble_${id}.webp`;
        if (!shipsHubble.has(id) && fs.existsSync(path.join(SKY, stale))) {
          save(stale); changes.removed.push(stale);
          fs.rmSync(path.join(SKY, stale));
          purgeResizedThumbnails(SKY, id, 'hubble');
        }
      }

      const descriptions = JSON.parse(fs.readFileSync(path.join(work, 'descriptions.json'), 'utf8')) as Record<string, { extract: string; sourceUrl: string; source: string; status: string }>;
      db.transaction(() => {
        for (const [objectId, d] of Object.entries(descriptions)) {
          const id = resolveCanonicalId(objectId);
          const before = getRow.get(id) as Record<string, unknown> | undefined;
          if (!changes.cacheRows.some(r => r.objectId === id)) changes.cacheRows.push({ objectId: id, before: before ?? null });
          put.run(id, d.extract, d.sourceUrl, d.source, now, d.status);
        }
      })();

      const creditsName = `credits-${tier}.json`;
      if (fs.existsSync(path.join(SKY, creditsName))) save(creditsName);
      fs.copyFileSync(path.join(work, 'credits.json'), path.join(SKY, creditsName));
      changes.credits.push(creditsName);
      console.log(`${tier}: ${images.length} pictures, ${Object.keys(descriptions).length} descriptions`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(LOG, JSON.stringify(changes, null, 2));
  console.log(`\nLoaded ${loaded} pictures: ${changes.replaced.length} replaced, ${changes.added.length} added, ${changes.removed.length} stale Hubble pictures removed, ${changes.cacheRows.length} descriptions written.`);
  console.log('Backup: data/pack-load-backup. Start the server with NEBULIS_SKIP_PACK_INSTALL=1 npm run dev so it keeps them.');
}

const arg = process.argv[2];
if (!arg) { console.error('usage: catalog-load-local.ts <packs folder> | --undo'); process.exit(1); }
refuseIfRunning();
if (arg === '--undo') undo(); else load(arg);
