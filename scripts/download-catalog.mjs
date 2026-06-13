/**
 * Downloads the OpenNGC catalog from GitHub and produces a Seestar-filtered JSON.
 * Run with: node scripts/download-catalog.mjs
 *
 * OpenNGC is MIT licensed: https://github.com/mattiaverga/OpenNGC
 *
 * The output (server/data/openngc.json) is committed to the repo so the server
 * works without internet access. Re-run this script whenever you want fresh data.
 */

import https from 'https';
import { createWriteStream, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_FILE = join(ROOT, 'server', 'data', 'openngc.json');
const TMP_CSV = join(tmpdir(), 'openngc-ngc.csv');
const TMP_ADDENDUM = join(tmpdir(), 'openngc-addendum.csv');

const OPENNGC_URL = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv';
const OPENNGC_ADDENDUM_URL = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv';

// Object types to keep (Seestar can image these).
// `Neb` is OpenNGC's generic nebula tag and covers M8/M16/M17/M20 plus ~90 others.
// Messier-tagged rows always pass regardless of type — see the `always include
// Messiers` rule below, which guarantees entries like M24 (*Ass) and M45 (OCl
// from addendum) make it into the final catalog even when their type/size would
// normally be filtered out.
const KEEP_TYPES = new Set([
  'OCl', 'GCl', 'Cl+N', 'G', 'GPair', 'GTrpl', 'GGroup',
  'PN', 'HII', 'EmN', 'RfN', 'SNR', 'Neb',
]);

// IAU 3-letter constellation codes → full names
const CONSTELLATIONS = {
  And:'Andromeda', Ant:'Antlia', Aps:'Apus', Aqr:'Aquarius', Aql:'Aquila',
  Ara:'Ara', Ari:'Aries', Aur:'Auriga', Boo:'Boötes', Cae:'Caelum',
  Cam:'Camelopardalis', Cnc:'Cancer', CVn:'Canes Venatici', CMa:'Canis Major',
  CMi:'Canis Minor', Cap:'Capricornus', Car:'Carina', Cas:'Cassiopeia',
  Cen:'Centaurus', Cep:'Cepheus', Cet:'Cetus', Cha:'Chamaeleon', Cir:'Circinus',
  Col:'Columba', Com:'Coma Berenices', CrA:'Corona Australis', CrB:'Corona Borealis',
  Crv:'Corvus', Crt:'Crater', Cru:'Crux', Cyg:'Cygnus', Del:'Delphinus',
  Dor:'Dorado', Dra:'Draco', Equ:'Equuleus', Eri:'Eridanus', For:'Fornax',
  Gem:'Gemini', Gru:'Grus', Her:'Hercules', Hor:'Horologium', Hya:'Hydra',
  Hyi:'Hydrus', Ind:'Indus', Lac:'Lacerta', Leo:'Leo', LMi:'Leo Minor',
  Lep:'Lepus', Lib:'Libra', Lup:'Lupus', Lyn:'Lynx', Lyr:'Lyra', Men:'Mensa',
  Mic:'Microscopium', Mon:'Monoceros', Mus:'Musca', Nor:'Norma', Oct:'Octans',
  Oph:'Ophiuchus', Ori:'Orion', Pav:'Pavo', Peg:'Pegasus', Per:'Perseus',
  Phe:'Phoenix', Pic:'Pictor', Psc:'Pisces', PsA:'Piscis Austrinus', Pup:'Puppis',
  Pyx:'Pyxis', Ret:'Reticulum', Sge:'Sagitta', Sgr:'Sagittarius', Sco:'Scorpius',
  Scl:'Sculptor', Sct:'Scutum', Se1:'Serpens Caput', Se2:'Serpens Cauda',
  Sex:'Sextans', Tau:'Taurus', Tel:'Telescopium', Tri:'Triangulum',
  TrA:'Triangulum Australe', Tuc:'Tucana', UMa:'Ursa Major', UMi:'Ursa Minor',
  Vel:'Vela', Vir:'Virgo', Vol:'Volans', Vul:'Vulpecula',
};

/**
 * Common-name corrections for famous objects where OpenNGC is wrong or silent.
 *
 * These patches run AFTER the raw catalog is built, so the keys are the final
 * post-stripping ids (e.g. "IC434" not "IC0434"). Each override:
 *   - `name`     replaces the primary display name
 *   - `aliases`  additional search-only names appended to commonNames
 *
 * Keep this list tight — only fixes for objects that are (a) commonly searched
 * by amateur astronomers and (b) mislabeled or unlabeled upstream. Anything
 * with a reasonable existing `name` should be left alone.
 */
const COMMON_NAME_OVERRIDES = {
  // OpenNGC mislabels IC434 as "Flame Nebula"; the actual Flame is NGC2024.
  // IC434 is the red emission region where the Horsehead (Barnard 33) is
  // silhouetted — universally known as "the Horsehead Nebula".
  'IC434':   { name: 'Horsehead Nebula', aliases: ['B33', 'Barnard 33'] },
  'NGC2024': { name: 'Flame Nebula' },

  // "Sculptor Filament" is an obscure cosmological reference. The galaxy is
  // universally called the Sculptor Galaxy (or Silver Coin Galaxy).
  'NGC253':  { name: 'Sculptor Galaxy' },

  // Rosette Nebula is a ring of several NGC designations. NGC2237 is labeled
  // "Rosette A" in OpenNGC but most imagers treat any of them as "the Rosette".
  'NGC2237': { name: 'Rosette Nebula' },

  // Heart/Soul region — OpenNGC has no common names for these despite being
  // two of the most-imaged nebulae in the northern sky.
  'IC1805':  { name: 'Heart Nebula' },
  'IC1848':  { name: 'Soul Nebula' },

  // IC1396 is the HII region in Cepheus; the Elephant Trunk (vdB 142) is a
  // dark cloud within it, but the whole complex is popularly known this way.
  'IC1396':  { name: 'Elephant Trunk Nebula' },

  // Unnamed in OpenNGC.
  'IC410':   { name: 'Tadpoles Nebula' },
  'NGC6334': { name: "Cat's Paw Nebula" },
  'NGC2359': { name: "Thor's Helmet" },
  'NGC281':  { name: 'Pacman Nebula' },
  'NGC7331': { name: 'Deer Lick Group' },

  // Strip the leading "the " article that OpenNGC includes on some names.
  'NGC1977': { name: 'Running Man Nebula' },
  'NGC1909': { name: 'Witch Head Nebula' }, // was "the Witch Head Nebula"
};

// Human-friendly type labels
const TYPE_LABELS = {
  'OCl': 'Open Cluster',
  'GCl': 'Globular Cluster',
  'Cl+N': 'Cluster + Nebula',
  'G': 'Galaxy',
  'GPair': 'Galaxy Pair',
  'GTrpl': 'Galaxy Triplet',
  'GGroup': 'Galaxy Group',
  'PN': 'Planetary Nebula',
  'HII': 'Emission Nebula',
  'EmN': 'Emission Nebula',
  'RfN': 'Reflection Nebula',
  'SNR': 'Supernova Remnant',
  'Neb': 'Nebula',
  '*Ass': 'Star Cloud',
  '**': 'Double Star',
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function parseRA(ra) {
  // "HH:MM:SS.ss" → decimal hours
  if (!ra || ra.trim() === '') return null;
  const parts = ra.trim().split(':');
  if (parts.length < 2) return null;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2] ?? '0');
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60 + s / 3600;
}

function parseDec(dec) {
  // "+/-DD:MM:SS.ss" → decimal degrees
  if (!dec || dec.trim() === '') return null;
  const sign = dec.trim().startsWith('-') ? -1 : 1;
  const parts = dec.trim().replace(/^[+-]/, '').split(':');
  if (parts.length < 2) return null;
  const d = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2] ?? '0');
  if (isNaN(d) || isNaN(m)) return null;
  return sign * (d + m / 60 + s / 3600);
}

function isSeestарVisible(type, vMag, bMag, majAx) {
  // Treat NaN as "unknown magnitude" — callers may pass NaN when a CSV cell
  // was non-empty but failed to parse as a number. `?? ` only catches null
  // and undefined, so we normalize NaN → null here before coalescing.
  const v = Number.isFinite(vMag) ? vMag : null;
  const b = Number.isFinite(bMag) ? bMag : null;
  const a = Number.isFinite(majAx) ? majAx : null;
  const mag = v ?? b;

  switch (type) {
    case 'G':
    case 'GPair':
    case 'GTrpl':
    case 'GGroup':
      // Galaxies: bright enough AND large enough to show structure
      return (mag == null || mag <= 13.5) && (a == null || a >= 0.3);

    case 'OCl':
      // Open clusters: generous mag limit (extended objects)
      return mag == null || mag <= 12;

    case 'GCl':
      // Globular clusters
      return mag == null || mag <= 12;

    case 'Cl+N':
      return mag == null || mag <= 12;

    case 'PN':
      // Planetary nebulae: can be faint but small PNe need decent size
      return (mag == null || mag <= 13.5) && (a == null || a >= 0.1);

    case 'HII':
    case 'EmN':
    case 'RfN':
    case 'SNR':
    case 'Neb':
      // Nebulae: size matters more than mag — Seestar's dual-band filter helps a lot
      return a == null || a >= 1.5;

    default:
      return false;
  }
}

async function parseCsv(csvPath) {
  const rl = createInterface({ input: createReadStream(csvPath) });
  const rows = [];
  let headers = null;

  for await (const line of rl) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const cols = line.split(';');
    if (!headers) {
      headers = cols.map(h => h.trim());
      continue;
    }
    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? '').trim(); });
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Convert a raw CSV row into a catalog entry, or `null` if the row should be
 * skipped. Messier-tagged entries ALWAYS pass — even if their type is not in
 * `KEEP_TYPES` (M24 is `*Ass`) or their size would normally filter them out.
 * This is the simplest rule that guarantees all 110 Messiers end up in the
 * final catalog without hand-maintaining an exception list.
 */
function rowToEntry(row) {
  const type = row['Type'] ?? row['type'] ?? '';
  const name = row['Name'] ?? row['name'] ?? '';
  if (!name) return null;

  const messierRaw = row['M'] ?? row['Messier'] ?? '';
  const messierNum = messierRaw.trim() ? parseInt(messierRaw, 10) : null;
  const isMessier = messierNum != null && !isNaN(messierNum);

  // Non-Messier rows must clear the type whitelist + visibility heuristic.
  // Messier rows bypass both — they're always Seestar-appropriate.
  if (!isMessier) {
    if (!KEEP_TYPES.has(type)) return null;
  }

  const vMag = row['V-Mag'] !== '' ? parseFloat(row['V-Mag']) : null;
  const bMag = row['B-Mag'] !== '' ? parseFloat(row['B-Mag']) : null;
  const majAxRaw = row['MajAx'] !== '' ? parseFloat(row['MajAx']) : null;

  if (!isMessier && !isSeestарVisible(type, vMag, bMag, majAxRaw)) {
    return null;
  }

  const ra = parseRA(row['RA'] ?? row['Ra'] ?? '');
  const dec = parseDec(row['Dec'] ?? row['dec'] ?? '');
  if (ra === null || dec === null) return null;

  // Display id: strip leading zeros after the catalog prefix so "NGC0253" → "NGC253",
  // "IC0434" → "IC434". ngcName keeps the original zero-padded form for lookups.
  const compactName = name.replace(/\s+/g, '').replace(/^([A-Za-z]+)0+(\d)/, '$1$2');
  const id = isMessier ? `M${messierNum}` : compactName;

  const commonNamesRaw = row['Common names'] ?? row['CommonNames'] ?? row['Identifiers'] ?? '';
  const commonNames = commonNamesRaw
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);

  const displayName = commonNames[0] || (isMessier ? `Messier ${messierNum}` : id);
  const constCode = (row['Const'] ?? row['constellation'] ?? '').trim();
  const constellation = CONSTELLATIONS[constCode] ?? constCode ?? null;

  return {
    id,
    ngcName: name,
    name: displayName,
    type: TYPE_LABELS[type] ?? type,
    typeCode: type,
    constellation: constellation || null,
    messier: isMessier ? messierNum : null,
    ra,        // decimal hours
    dec,       // decimal degrees
    magnitude: vMag ?? bMag ?? null,
    majorAxisArcmin: majAxRaw ?? null,
    commonNames,
  };
}

async function main() {
  console.log('Downloading OpenNGC main catalog…');
  await download(OPENNGC_URL, TMP_CSV);
  console.log('  →', TMP_CSV);

  console.log('Downloading OpenNGC addendum…');
  await download(OPENNGC_ADDENDUM_URL, TMP_ADDENDUM);
  console.log('  →', TMP_ADDENDUM);

  console.log('Parsing CSVs…');
  const mainCsv = await parseCsv(TMP_CSV);
  const addendumCsv = await parseCsv(TMP_ADDENDUM);
  console.log(`  main: ${mainCsv.rows.length} rows`);
  console.log(`  addendum: ${addendumCsv.rows.length} rows`);

  // Two-pass over both CSVs. Pass 1 builds primary entries and collects `Dup`
  // rows for later. Pass 2 attaches each Dup row's own name as an alias on its
  // target entry so users can search for the duplicate designation (e.g.
  // "IC2118" resolves to NGC1909, the Witch Head Nebula).
  const objects = [];
  const byNgcName = new Map(); // key = raw OpenNGC name (uppercase, no spaces)
  const dupRows = [];

  function ingest(rows) {
    for (const row of rows) {
      const type = row['Type'] ?? row['type'] ?? '';
      if (type === 'Dup') {
        dupRows.push(row);
        continue;
      }
      const entry = rowToEntry(row);
      if (entry) {
        objects.push(entry);
        byNgcName.set(entry.ngcName.toUpperCase().replace(/\s+/g, ''), entry);
      }
    }
  }
  ingest(mainCsv.rows);
  ingest(addendumCsv.rows);

  let dupAliasCount = 0;
  for (const row of dupRows) {
    const dupName = (row['Name'] ?? '').trim();
    if (!dupName) continue;

    // Target lives in either the NGC or IC column — both zero-padded to 4.
    const ngcRef = (row['NGC'] ?? '').trim();
    const icRef = (row['IC'] ?? '').trim();
    let targetKey = null;
    if (ngcRef) targetKey = `NGC${ngcRef}`;
    else if (icRef) targetKey = `IC${icRef}`;
    if (!targetKey) continue;

    const target = byNgcName.get(targetKey.toUpperCase());
    if (!target) continue;

    // Add both the padded form and the stripped form so search matches either.
    const compactDup = dupName.replace(/^([A-Za-z]+)0+(\d)/, '$1$2');
    for (const alias of new Set([dupName, compactDup])) {
      if (!target.commonNames.includes(alias)) {
        target.commonNames.push(alias);
      }
    }
    dupAliasCount++;
  }
  console.log(`  Dup aliases attached: ${dupAliasCount}`);

  // Deduplicate by ID — first wins. Since Messier rows produce their own
  // `M<n>` id they never collide with NGC rows, and the addendum only adds
  // entries (like M40, M45) that aren't in the main catalog at all.
  const seen = new Map();
  for (const obj of objects) {
    if (!seen.has(obj.id)) seen.set(obj.id, obj);
  }
  const deduplicated = Array.from(seen.values());

  // Apply common-name overrides for objects where OpenNGC is wrong or silent
  let overrideCount = 0;
  for (const entry of deduplicated) {
    const override = COMMON_NAME_OVERRIDES[entry.id];
    if (!override) continue;
    if (override.name) {
      // Replace both the primary display name and the corresponding entry
      // in commonNames so `getDisplayNames()` picks up the corrected label.
      const oldName = entry.name;
      entry.name = override.name;
      if (entry.commonNames.length > 0 && entry.commonNames[0] === oldName) {
        entry.commonNames[0] = override.name;
      } else if (!entry.commonNames.includes(override.name)) {
        entry.commonNames.unshift(override.name);
      }
    }
    if (override.aliases) {
      for (const alias of override.aliases) {
        if (!entry.commonNames.includes(alias)) entry.commonNames.push(alias);
      }
    }
    overrideCount++;
  }
  console.log(`  Common-name overrides applied: ${overrideCount}`);

  deduplicated.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  mkdirSync(join(ROOT, 'server', 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(deduplicated, null, 2));

  console.log(`\nDone! ${deduplicated.length} Seestar-appropriate objects written to:`);
  console.log(' ', OUT_FILE);

  // Sanity-check Messier coverage
  const messierCount = deduplicated.filter(o => o.messier != null).length;
  const messierNums = new Set(deduplicated.filter(o => o.messier != null).map(o => o.messier));
  const missing = [];
  for (let i = 1; i <= 110; i++) if (!messierNums.has(i)) missing.push(i);
  console.log(`\nMessier coverage: ${messierCount}/110${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  console.log('\nType breakdown:');
  const counts = {};
  for (const o of deduplicated) counts[o.type] = (counts[o.type] ?? 0) + 1;
  for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
