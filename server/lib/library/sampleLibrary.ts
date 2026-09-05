/**
 * The product tour's demo object.
 *
 * Plants a single object (the Andromeda Galaxy, M31) so the tour has
 * something real to show in the library grid, the object page, and the
 * processed-images rollup before the user has connected a telescope.
 *
 * It is a stage prop, not a gift: `plantSampleObject()` runs when the tour
 * starts and `purgeSampleObject()` removes it — every row, every file — when
 * the tour ends. A tour abandoned by closing the browser leaves it behind, so
 * the next server boot purges it too. The user's library is only ever left
 * holding things the user actually put there.
 *
 * Two rules keep it away from real data:
 *  - It is only ever planted into an empty library, so it can never appear
 *    alongside (or on top of) someone's real objects.
 *  - The purge only removes the objectId recorded in `appSettings.sampleObjectId`
 *    when it was planted, so it can only ever delete an object this code put
 *    there.
 *
 * Every file — the processed hero image, the stacked previews, and the
 * sub-frames — is generated at seed time (a rendered SVG piped through
 * `sharp` for the JPGs, raw pixels for the FITS). Nothing is read from a
 * bundled asset directory. This used to copy real JPGs out of a committed
 * `server/data/sample-library` bundle, whose location on disk had to be
 * re-derived at runtime relative to the running module. That worked for
 * `tsx`/Docker but silently failed on every native installer build (Windows
 * exe and macOS .pkg): tsup bundles the whole server into one file, which
 * collapses the source tree's directory depth, so the path arithmetic that
 * correctly finds `server/data/sample-library` from source finds nothing in
 * the packaged layout. `copyAsset` threw, the outer catch below swallowed it,
 * and no packaged install ever got the sample object — only `tsx` and Docker
 * did. Generating the files in-process removes the bundled-directory
 * dependency entirely, so there is no "wrong build target" left to get wrong.
 *
 * Invariants, matching the rest of the library:
 *  - Everything is addressed relative to getLibraryDir(); nothing absolute is
 *    persisted.
 *  - Planting is skipped when the library is unavailable or a relocation
 *    migration is in flight, and neither plant nor purge can throw at boot.
 */
import fs from 'fs';
import path from 'path';
import sharp from '../sharp-optional.js';
import { log } from '../logger.js';
import db from '../db.js';
import { getLibraryDir } from '../libraryPath.js';
import { isLibraryMigrating } from '../libraryMaintenance.js';
import {
  stmts,
  applyCatalogMetaToLibraryObject,
  resolveContainedObjectDir,
} from './objects.js';
import { recordLibraryFile } from './libraryFiles.js';
import { setObjectLayout } from './libraryLayout.js';
import { getActiveSite, updateSite } from '../observingSites.js';

export const SAMPLE_OBJECT_ID = 'M31';
export const SAMPLE_FOLDER_NAME = 'M31';
export const SAMPLE_SESSION_DATE = '2025-09-14';
const SAMPLE_SESSION_FOLDER = '2025-09-14_22-03-00';
const SUBFRAME_COUNT = 12;

/** Deterministic PRNG (Park-Miller) so the same seed always renders the same
 *  image — reproducible output, no dependency on Math.random(). */
function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Renders a stylized "galaxy" thumbnail as SVG: a dark starfield behind a
 *  soft, tilted core + halo, roughly evoking Andromeda's look. Not meant to
 *  be realistic — just enough that the sample object's thumbnail, hero image,
 *  and stacked previews look like a real target instead of a blank tile. */
function renderGalaxySvg(width: number, height: number, seed: number): string {
  const rand = seededRandom(seed);
  const cx = width / 2;
  const cy = height / 2;
  const coreRx = width * 0.26;
  const coreRy = height * 0.09;

  let stars = '';
  const starCount = Math.round((width * height) / 3200);
  for (let i = 0; i < starCount; i++) {
    const x = (rand() * width).toFixed(1);
    const y = (rand() * height).toFixed(1);
    const r = (0.4 + rand() * 1.3).toFixed(2);
    const o = (0.2 + rand() * 0.6).toFixed(2);
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${o}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <radialGradient id="bg" cx="50%" cy="50%" r="75%">
    <stop offset="0%" stop-color="#0a0e1a"/>
    <stop offset="100%" stop-color="#000000"/>
  </radialGradient>
  <radialGradient id="halo" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#dce6ff" stop-opacity="0.5"/>
    <stop offset="35%" stop-color="#93a8e8" stop-opacity="0.25"/>
    <stop offset="100%" stop-color="#93a8e8" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="core" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#fffdf4" stop-opacity="0.95"/>
    <stop offset="45%" stop-color="#f3ecff" stop-opacity="0.45"/>
    <stop offset="100%" stop-color="#f3ecff" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/>
${stars}
<g transform="rotate(-18 ${cx} ${cy})">
  <ellipse cx="${cx}" cy="${cy}" rx="${coreRx * 2.1}" ry="${coreRy * 2.8}" fill="url(#halo)"/>
  <ellipse cx="${cx}" cy="${cy}" rx="${coreRx}" ry="${coreRy}" fill="url(#core)"/>
</g>
</svg>`;
}

/** Renders and writes one synthetic JPEG, returning its size in bytes. */
async function writeSyntheticJpeg(destAbs: string, width: number, height: number, seed: number): Promise<number> {
  const svg = renderGalaxySvg(width, height, seed);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(destAbs);
  return fs.statSync(destAbs).size;
}

/** Write a small valid 16-bit grayscale FITS file (with a header the FITS
 *  parser and sub-frame scorer understand) for one synthetic sub-frame. */
function writeSyntheticSubframe(destAbs: string, index: number): number {
  const width = 96;
  const height = 96;
  const bitpix = 16;
  const dataBytes = width * height * (bitpix / 8);

  // 80-byte header cards; pad to a multiple of 2880 bytes (36 cards/block).
  const cards: string[] = [
    'SIMPLE  =                    T',
    'BITPIX  =                   16',
    'NAXIS   =                    2',
    `NAXIS1  =                   ${width}`,
    `NAXIS2  =                   ${height}`,
    "OBJECT  = 'M 31'",
    "FILTER  = 'IRCUT'",
    'EXPTIME =                 20.0',
    `EXPOSURE=                 20.0`,
    `CCD-TEMP=              ${(-5 + (index % 7) / 10).toFixed(1)}`,
    `HFR     =             ${(1.5 + (index % 5) / 6).toFixed(2)}`,
    `FWHM    =             ${(2.0 + (index % 4) / 5).toFixed(2)}`,
    `STARS   =                 ${120 - index * 3}`,
    `BACKGND =               ${(340 + index * 2)}`,
    `DATE-OBS= '2025-09-14T22:0${index < 10 ? '0' : ''}${index}:00'`,
  ];
  // DATE-OBS above can exceed 60s for index >= 10; keep it well-formed.
  cards[cards.length - 1] = `DATE-OBS= '2025-09-14T22:0${index % 10}${Math.min(index, 5) % 10}:00'`;

  let header = '';
  for (const card of cards) {
    header += card.padEnd(80, ' ').slice(0, 80);
  }
  header += 'END'.padEnd(80, ' ');
  // Pad the header to whole 2880-byte blocks.
  const blocks = Math.ceil(header.length / 2880);
  header = header.padEnd(blocks * 2880, ' ');

  // Simple pseudo-galaxy gradient: brighter toward one corner.
  const data = Buffer.alloc(dataBytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      // A soft core + a couple of spiral-arm ripples, so the rendered thumb
      // looks like a galaxy smudge rather than flat noise.
      const value = Math.round(
        80 + 1800 * Math.exp(-(r * r) / (14 * 14))
          + 400 * Math.exp(-((r - 20) * (r - 20)) / 40) * (0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 2))
          + ((index * 7 + x + y) % 5),
      );
      data.writeInt16BE(Math.max(0, Math.min(32767, value)), (y * width + x) * 2);
    }
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.writeFileSync(destAbs, Buffer.concat([Buffer.from(header, 'ascii'), data]));
  return fs.statSync(destAbs).size;
}

/** Does the sample object already exist (any object at all, seeded or real)? */
function objectCount(): number {
  return stmts.getAllObjects.all().length;
}

/** The objectId of the currently-planted sample, or null when none is.
 *
 *  Read and written straight against the row: `getSettingsData()` maps rows
 *  through an explicit column list that does not carry this bookkeeping
 *  column, so a value set here would read back as `undefined` through it. */
function plantedObjectId(): string | null {
  const row = db.prepare<[], { sampleObjectId: string }>(
    'SELECT sampleObjectId FROM appSettings WHERE id = 1',
  ).get();
  return row?.sampleObjectId ? row.sampleObjectId : null;
}

function setPlantedObjectId(objectId: string): void {
  db.prepare('UPDATE appSettings SET sampleObjectId = ? WHERE id = 1').run(objectId);
}

// ─── Demo location ───────────────────────────────────────────────────────────
// The Planner computes nothing without coordinates, so the tour's planner step
// on a fresh install would otherwise land on the "Location not set" setup
// prompt. Filling in a site for the length of the tour lets the real Planner
// render — real night window, real target altitudes, real visibility colours —
// instead of a mock-up of it.
//
// The site is renamed while it is borrowed so nobody mistakes it for their own,
// and the previous name is stored so the purge restores it exactly.

const DEMO_SITE_NAME = 'Example location (San Francisco)';
const DEMO_LATITUDE = 37.7749;
const DEMO_LONGITUDE = -122.4194;

function plantedLocation(): { siteId: string; prevName: string } | null {
  const row = db.prepare<[], { sampleLocationSiteId: string; sampleLocationPrevName: string }>(
    'SELECT sampleLocationSiteId, sampleLocationPrevName FROM appSettings WHERE id = 1',
  ).get();
  if (!row?.sampleLocationSiteId) return null;
  return { siteId: row.sampleLocationSiteId, prevName: row.sampleLocationPrevName };
}

function setPlantedLocation(siteId: string, prevName: string): void {
  db.prepare('UPDATE appSettings SET sampleLocationSiteId = ?, sampleLocationPrevName = ? WHERE id = 1')
    .run(siteId, prevName);
}

/** Fill in coordinates on the site the Planner computes for, but only when the
 *  user has none of their own. Returns true when one was planted. */
function plantDemoLocation(): boolean {
  if (plantedLocation()) return true;

  const site = getActiveSite();
  // The user has their own coordinates: the Planner already works, so leave
  // it completely alone.
  if (site.latitude !== null && site.longitude !== null) return false;

  updateSite(site.id, {
    name: DEMO_SITE_NAME,
    latitude: DEMO_LATITUDE,
    longitude: DEMO_LONGITUDE,
  });
  setPlantedLocation(site.id, site.name);
  return true;
}

/** Put the borrowed site back to having no coordinates and its old name. */
function purgeDemoLocation(): boolean {
  const planted = plantedLocation();
  if (!planted) return false;

  updateSite(planted.siteId, {
    name: planted.prevName || 'My Location',
    latitude: null,
    longitude: null,
  });
  setPlantedLocation('', '');
  return true;
}

/** Adopt a sample left behind by the older build that planted M31 at boot and
 *  left it in the library for good. Without this, the object already sitting
 *  in those users' libraries would have no record marking it as ours and
 *  would never be cleaned up.
 *
 *  Deliberately narrow: the old seeder set `sampleLibrarySeeded`, the library
 *  must contain that object and nothing else, and it must carry the synthetic
 *  session folder only the seeder ever writes. A real library fails at least
 *  one of those. */
function adoptLegacyPlantedSample(): void {
  if (plantedObjectId()) return;
  const flag = db.prepare<[], { sampleLibrarySeeded: number }>(
    'SELECT sampleLibrarySeeded FROM appSettings WHERE id = 1',
  ).get();
  if ((flag?.sampleLibrarySeeded ?? 0) !== 1) return;

  const objects = stmts.getAllObjects.all();
  if (objects.length !== 1 || objects[0].objectId !== SAMPLE_OBJECT_ID) return;

  const signature = db.prepare<[string, string], { n: number }>(
    'SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ? AND relPath LIKE ?',
  ).get(SAMPLE_OBJECT_ID, `${SAMPLE_FOLDER_NAME}/${SAMPLE_SESSION_FOLDER}/%`);
  if ((signature?.n ?? 0) === 0) return;

  setPlantedObjectId(SAMPLE_OBJECT_ID);
}

/** What a plant actually put in place. Either half can be declined on its own:
 *  a user with real objects but no coordinates gets the location only, and one
 *  who has set a location but has an empty library gets the object only. */
export interface TourDemoState {
  object: boolean;
  location: boolean;
}

/** Plant the demo props for a tour run. Idempotent and guarded; never throws.
 *
 *  Called when the tour starts, not at boot: these exist only for the duration
 *  of a tour. */
export async function plantSampleObject(): Promise<TourDemoState> {
  try {
    if (process.env.NEBULIS_SKIP_SAMPLE_LIBRARY === '1') return { object: false, location: false };

    // Coordinates first: independent of the object, and the step that needs
    // them (the Planner) comes before the one that needs the object.
    const location = plantDemoLocation();

    // Already planted (e.g. the tour was restarted): nothing to do, and the
    // caller can go ahead and use it.
    if (plantedObjectId()) return { object: true, location };

    // Only ever plant into an empty library. A user with real objects has
    // something for the tour to point at already, and a demo object must
    // never turn up beside their own work.
    if (objectCount() > 0) return { object: false, location };
    if (isLibraryMigrating()) return { object: false, location };

    const libDir = getLibraryDir();
    const sessionDir = path.join(libDir, SAMPLE_FOLDER_NAME, SAMPLE_SESSION_FOLDER);
    const processedName = 'heic0512d.jpg';

    // 1. Render the processed hero image + stacked previews (synthetic, no
    //    bundled assets involved).
    await writeSyntheticJpeg(
      path.join(libDir, SAMPLE_FOLDER_NAME, 'processed', processedName),
      1024, 768, 31,
    );
    const stacked = [
      'Stacked_146_M 31_10.0s_IRCUT_20241001-205836.jpg',
      'Stacked_286_M 31_10.0s_IRCUT_20241120-183739.jpg',
      'Stacked_333_M 31_10.0s_LP_20241006-051505.jpg',
    ];
    for (let i = 0; i < stacked.length; i++) {
      await writeSyntheticJpeg(path.join(sessionDir, stacked[i]), 640, 480, 100 + i);
    }

    // 2. Register the object row; catalog columns + gallery image + layout get
    //    stamped next (the upsert statement covers catalog columns only).
    stmts.upsertObject.run(
      SAMPLE_OBJECT_ID,                // objectId
      SAMPLE_FOLDER_NAME,              // folderName
      0,                               // fileCount (updated below)
      new Date().toISOString(),        // lastImport
      0,                               // deleted
      null,                             // deletedAt
      null, null, null, null, null, null, null, null, null, // catalog columns
    );
    stmts.setGalleryImage.run(`${SAMPLE_FOLDER_NAME}/processed/${processedName}`, SAMPLE_OBJECT_ID);
    setObjectLayout(SAMPLE_OBJECT_ID, 'nested');

    // 3. Register the observing night.
    stmts.addSessionStamped.run(SAMPLE_OBJECT_ID, SAMPLE_SESSION_DATE, null);

    // 4. Record the stacked preview files and synth sub-frames.
    for (const name of stacked) {
      const destAbs = path.join(sessionDir, name);
      recordLibraryFile({
        objectId: SAMPLE_OBJECT_ID,
        folderName: SAMPLE_FOLDER_NAME,
        sessionFolder: SAMPLE_SESSION_FOLDER,
        fileName: name,
        originalName: name,
        role: 'preview',
        captureDate: SAMPLE_SESSION_DATE,
        captureTime: '220300',
        bytes: fs.statSync(destAbs).size,
        telescopeId: null,
      });
    }
    for (let i = 0; i < SUBFRAME_COUNT; i++) {
      const name = `M31_${SAMPLE_SESSION_DATE}_22-0${i % 10}-0${Math.min(i % 6, 5)}_sub.fit`;
      const destAbs = path.join(sessionDir, name);
      const bytes = writeSyntheticSubframe(destAbs, i);
      recordLibraryFile({
        objectId: SAMPLE_OBJECT_ID,
        folderName: SAMPLE_FOLDER_NAME,
        sessionFolder: SAMPLE_SESSION_FOLDER,
        fileName: name,
        originalName: name,
        role: 'sub',
        captureDate: SAMPLE_SESSION_DATE,
        captureTime: `22${(i % 10).toString().padStart(2, '0')}${(i % 6).toString().padStart(2, '0')}`,
        bytes,
        telescopeId: null,
      });
    }

    // 5. Register the processed image row (JPG → renderable). The gallery
    //    image set in step 2 already points at this path.
    const procId = `seed_${Date.now().toString(36)}`;
    stmts.insertProcessedImage.run(
      procId,
      SAMPLE_OBJECT_ID,
      SAMPLE_SESSION_DATE,
      processedName,
      processedName,
      'M31 — Andromeda Galaxy',
      '',
      fs.statSync(path.join(libDir, SAMPLE_FOLDER_NAME, 'processed', processedName)).size,
      'image/jpeg',
      new Date().toISOString(),
      null,
      'user',
    );

    // 6. Update the object's file count to reflect everything now on disk, then
    //    fill catalog metadata (name, type, constellation, mag, coords, dist).
    const totalFiles = stacked.length + SUBFRAME_COUNT + 1; // +1 processed
    stmts.updateObjectFileCount.run(totalFiles, SAMPLE_OBJECT_ID);
    applyCatalogMetaToLibraryObject(SAMPLE_OBJECT_ID);
    // Record it as ours. Written last: until this lands, the purge will not
    // touch what was written above, so a crash mid-plant leaves an object the
    // user can delete themselves rather than one this code might delete out
    // from under a library it does not own.
    setPlantedObjectId(SAMPLE_OBJECT_ID);

    log.info(
      { objectId: SAMPLE_OBJECT_ID, subframes: SUBFRAME_COUNT, stacked: stacked.length },
      '[sample-library] Planted M31 demo object for the product tour',
    );
    return { object: true, location };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[sample-library] Plant skipped',
    );
    return { object: false, location: false };
  }
}

/** Every table that carries user-owned rows keyed by objectId. The demo object
 *  is reachable from the tour, so a user can favourite it, note it, or drop it
 *  on the planner before the tour ends — all of which must go with it.
 *
 *  `catalogCache` is deliberately absent: it caches the real M31 catalog
 *  entry, which is not library ownership data and is shared with the Catalogs
 *  pages. */
const OBJECT_SCOPED_TABLES = [
  'librarySessions',
  'libraryDeletedSessions',
  'libraryFiles',
  'captureInfo',
  'favorites',
  'notes',
  'wishlist',
  'plannedSessions',
  'sessionProcessedImages',
  'processingRuns',
  'sessionImportLog',
  'catalogOverrides',
] as const;

/**
 * Remove the planted demo object completely: every row, and its directory.
 *
 * This is a hard delete, deliberately NOT `deleteLocalObject()`. That function
 * tombstones (`deleted = 1` + `deletedAt`), which is right for a user deleting
 * their own object — it surfaces in the trash view and blocks the object from
 * re-syncing. Applying it to a demo object would leave a phantom "M31 was
 * deleted" entry in the user's trash and, worse, block their real Andromeda
 * data from ever importing off their telescope. A stage prop has to leave no
 * trace at all.
 *
 * Only ever removes the objectId recorded when it was planted. Never throws.
 */
export function purgeSampleObject(): TourDemoState {
  try {
    const location = purgeDemoLocation();

    adoptLegacyPlantedSample();
    const objectId = plantedObjectId();
    if (!objectId) return { object: false, location };

    // Resolve the directory before the rows go, while folderName is still
    // readable, and confirm it stays inside the library root.
    const objDir = resolveContainedObjectDir(objectId);

    db.transaction(() => {
      for (const table of OBJECT_SCOPED_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE objectId = ?`).run(objectId);
      }
      // Hard delete, no tombstone — see the note above.
      db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
      db.prepare("UPDATE appSettings SET sampleObjectId = '' WHERE id = 1").run();
    })();

    if (objDir && fs.existsSync(objDir)) {
      try { fs.rmSync(objDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    log.info({ objectId }, '[sample-library] Purged the tour demo object');
    return { object: true, location };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[sample-library] Purge skipped',
    );
    return { object: false, location: false };
  }
}
