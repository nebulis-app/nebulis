#!/usr/bin/env node
/**
 * One-shot build script: writes server/data/catalog-curated.json by:
 *   1. Looking up positional/type metadata from openngc.json (so coords don't
 *      have to be typed by hand for every entry).
 *   2. Fetching a 1–2 sentence description from Wikipedia.
 *   3. Falling back to entry-level overrides for anything OpenNGC + Wikipedia
 *      can't supply (Sharpless catalog, Barnard objects, manual distances).
 *
 *   node scripts/build-catalog-curated.mjs
 *
 * To add a new curated target: add `{ id, name, ... }` to the `entries` array
 * below and rerun. Most entries only need `{ id, name }` if OpenNGC covers
 * them; non-OpenNGC objects need `type`, `constellation`, `ra`, `dec`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'server', 'data', 'catalog-curated.json');
const OPENNGC_PATH = path.join(REPO_ROOT, 'server', 'data', 'openngc.json');

// ─── Curated target list ────────────────────────────────────────────────────
//
// Each entry needs at minimum `{ id, name }`. Anything else is optional and
// overrides the OpenNGC lookup. Non-OpenNGC objects (Sharpless, Barnard) must
// provide `type`, `constellation`, `ra`, `dec` themselves.

const entries = [
  // ─── Messier objects (all 110) ────────────────────────────────────────────
  { id: 'M1',  name: 'Crab Nebula',                 type: 'Supernova Remnant',          distanceLy: 6500 },
  { id: 'M2',  name: 'Messier 2',                                                       distanceLy: 37500 },
  { id: 'M3',  name: 'Messier 3',                                                       distanceLy: 33900 },
  { id: 'M4',  name: 'Messier 4',                                                       distanceLy: 7200 },
  { id: 'M5',  name: 'Messier 5',                                                       distanceLy: 24500 },
  { id: 'M6',  name: 'Butterfly Cluster',                                               distanceLy: 1600 },
  { id: 'M7',  name: 'Ptolemy Cluster',                                                 distanceLy: 980 },
  { id: 'M8',  name: 'Lagoon Nebula',               type: 'Emission Nebula',            distanceLy: 4100 },
  { id: 'M9',  name: 'Messier 9',                                                       distanceLy: 25800 },
  { id: 'M10', name: 'Messier 10',                                                      distanceLy: 14300 },
  { id: 'M11', name: 'Wild Duck Cluster',                                               distanceLy: 6200 },
  { id: 'M12', name: 'Messier 12',                                                      distanceLy: 16000 },
  { id: 'M13', name: 'Hercules Cluster',            type: 'Globular Cluster',           distanceLy: 22200 },
  { id: 'M14', name: 'Messier 14',                                                      distanceLy: 30300 },
  { id: 'M15', name: 'Messier 15',                                                      distanceLy: 33600 },
  { id: 'M16', name: 'Eagle Nebula',                type: 'Emission Nebula',            distanceLy: 7000 },
  { id: 'M17', name: 'Omega Nebula',                type: 'Emission Nebula',            distanceLy: 5500 },
  { id: 'M18', name: 'Messier 18',                                                      distanceLy: 4900 },
  { id: 'M19', name: 'Messier 19',                                                      distanceLy: 28700 },
  { id: 'M20', name: 'Trifid Nebula',               type: 'Emission/Reflection Nebula', distanceLy: 5200 },
  { id: 'M21', name: 'Messier 21',                                                      distanceLy: 4250 },
  { id: 'M22', name: 'Sagittarius Cluster',                                             distanceLy: 10600 },
  { id: 'M23', name: 'Messier 23',                                                      distanceLy: 2150 },
  { id: 'M24', name: 'Sagittarius Star Cloud',                                          distanceLy: 10000 },
  { id: 'M25', name: 'Messier 25',                                                      distanceLy: 2000 },
  { id: 'M26', name: 'Messier 26',                                                      distanceLy: 5000 },
  { id: 'M27', name: 'Dumbbell Nebula',             type: 'Planetary Nebula',           distanceLy: 1360 },
  { id: 'M28', name: 'Messier 28',                                                      distanceLy: 17900 },
  { id: 'M29', name: 'Messier 29',                                                      distanceLy: 4000 },
  { id: 'M30', name: 'Messier 30',                                                      distanceLy: 26100 },
  { id: 'M31', name: 'Andromeda Galaxy',            type: 'Spiral Galaxy',              distanceLy: 2537000 },
  { id: 'M32', name: 'Messier 32',                                                      distanceLy: 2570000 },
  { id: 'M33', name: 'Triangulum Galaxy',           type: 'Spiral Galaxy',              distanceLy: 2730000 },
  { id: 'M34', name: 'Messier 34',                                                      distanceLy: 1500 },
  { id: 'M35', name: 'Messier 35',                                                      distanceLy: 2800 },
  { id: 'M36', name: 'Pinwheel Cluster',                                                distanceLy: 4100 },
  { id: 'M37', name: 'Messier 37',                                                      distanceLy: 4500 },
  { id: 'M38', name: 'Starfish Cluster',                                                distanceLy: 4200 },
  { id: 'M39', name: 'Messier 39',                                                      distanceLy: 825 },
  { id: 'M40', name: 'Winnecke 4',                                                      distanceLy: 510 },
  { id: 'M41', name: 'Messier 41',                                                      distanceLy: 2300 },
  { id: 'M42', name: 'Orion Nebula',                type: 'Emission/Reflection Nebula', distanceLy: 1344 },
  { id: 'M43', name: "De Mairan's Nebula",          type: 'Emission/Reflection Nebula', distanceLy: 1600 },
  { id: 'M44', name: 'Beehive Cluster',                                                 distanceLy: 577 },
  { id: 'M45', name: 'Pleiades',                                                        distanceLy: 444 },
  { id: 'M46', name: 'Messier 46',                                                      distanceLy: 5400 },
  { id: 'M47', name: 'Messier 47',                                                      distanceLy: 1600 },
  { id: 'M48', name: 'Messier 48',                                                      distanceLy: 2500 },
  { id: 'M49', name: 'Messier 49',                                                      distanceLy: 55900000 },
  { id: 'M50', name: 'Messier 50',                                                      distanceLy: 3200 },
  { id: 'M51', name: 'Whirlpool Galaxy',            type: 'Spiral Galaxy',              distanceLy: 23000000 },
  { id: 'M52', name: 'Messier 52',                                                      distanceLy: 5000 },
  { id: 'M53', name: 'Messier 53',                                                      distanceLy: 58000 },
  { id: 'M54', name: 'Messier 54',                                                      distanceLy: 87400 },
  { id: 'M55', name: 'Messier 55',                                                      distanceLy: 17600 },
  { id: 'M56', name: 'Messier 56',                                                      distanceLy: 32900 },
  { id: 'M57', name: 'Ring Nebula',                 type: 'Planetary Nebula',           distanceLy: 2283 },
  { id: 'M58', name: 'Messier 58',                                                      distanceLy: 62000000 },
  { id: 'M59', name: 'Messier 59',                                                      distanceLy: 60000000 },
  { id: 'M60', name: 'Messier 60',                                                      distanceLy: 55000000 },
  { id: 'M61', name: 'Messier 61',                                                      distanceLy: 52500000 },
  { id: 'M62', name: 'Messier 62',                                                      distanceLy: 22500 },
  { id: 'M63', name: 'Sunflower Galaxy',            type: 'Spiral Galaxy',              distanceLy: 29300000 },
  { id: 'M64', name: 'Black Eye Galaxy',            type: 'Spiral Galaxy',              distanceLy: 17000000 },
  { id: 'M65', name: 'Messier 65',                                                      distanceLy: 35000000 },
  { id: 'M66', name: 'Messier 66',                                                      distanceLy: 36000000 },
  { id: 'M67', name: 'Messier 67',                                                      distanceLy: 2700 },
  { id: 'M68', name: 'Messier 68',                                                      distanceLy: 33600 },
  { id: 'M69', name: 'Messier 69',                                                      distanceLy: 29700 },
  { id: 'M70', name: 'Messier 70',                                                      distanceLy: 29400 },
  { id: 'M71', name: 'Messier 71',                                                      distanceLy: 13000 },
  { id: 'M72', name: 'Messier 72',                                                      distanceLy: 54600 },
  { id: 'M73', name: 'Messier 73',                                                      distanceLy: 2500 },
  { id: 'M74', name: 'Messier 74',                                                      distanceLy: 32000000 },
  { id: 'M75', name: 'Messier 75',                                                      distanceLy: 67500 },
  { id: 'M76', name: 'Little Dumbbell Nebula',                                          distanceLy: 2500 },
  { id: 'M77', name: 'Cetus A',                                                         distanceLy: 47000000 },
  { id: 'M78', name: 'Messier 78',                                                      distanceLy: 1600 },
  { id: 'M79', name: 'Messier 79',                                                      distanceLy: 41000 },
  { id: 'M80', name: 'Messier 80',                                                      distanceLy: 32600 },
  { id: 'M81', name: "Bode's Galaxy",               type: 'Spiral Galaxy',              distanceLy: 11800000 },
  { id: 'M82', name: 'Cigar Galaxy',                type: 'Starburst Galaxy',           distanceLy: 11400000 },
  { id: 'M83', name: 'Southern Pinwheel Galaxy',                                        distanceLy: 14700000 },
  { id: 'M84', name: 'Messier 84',                                                      distanceLy: 60000000 },
  { id: 'M85', name: 'Messier 85',                                                      distanceLy: 60000000 },
  { id: 'M86', name: 'Messier 86',                                                      distanceLy: 52000000 },
  { id: 'M87', name: 'Virgo A',                                                         distanceLy: 53500000 },
  { id: 'M88', name: 'Messier 88',                                                      distanceLy: 47000000 },
  { id: 'M89', name: 'Messier 89',                                                      distanceLy: 50000000 },
  { id: 'M90', name: 'Messier 90',                                                      distanceLy: 58700000 },
  { id: 'M91', name: 'Messier 91',                                                      distanceLy: 63000000 },
  { id: 'M92', name: 'Messier 92',                                                      distanceLy: 26700 },
  { id: 'M93', name: 'Messier 93',                                                      distanceLy: 3600 },
  { id: 'M94', name: 'Messier 94',                                                      distanceLy: 16000000 },
  { id: 'M95', name: 'Messier 95',                                                      distanceLy: 32600000 },
  { id: 'M96', name: 'Messier 96',                                                      distanceLy: 31000000 },
  { id: 'M97', name: 'Owl Nebula',                  type: 'Planetary Nebula',           distanceLy: 2030 },
  { id: 'M98', name: 'Messier 98',                                                      distanceLy: 44400000 },
  { id: 'M99', name: 'Coma Pinwheel Galaxy',                                            distanceLy: 50200000 },
  { id: 'M100', name: 'Messier 100',                                                    distanceLy: 55000000 },
  { id: 'M101', name: 'Pinwheel Galaxy',            type: 'Spiral Galaxy',              distanceLy: 20900000 },
  { id: 'M102', name: 'Spindle Galaxy',             type: 'Lenticular Galaxy', constellation: 'Draco',     ra: '15h 06m 29s', dec: '+55° 45′ 48″', distanceLy: 50000000 },
  { id: 'M103', name: 'Messier 103',                                                    distanceLy: 8500 },
  { id: 'M104', name: 'Sombrero Galaxy',            type: 'Spiral Galaxy',              distanceLy: 29300000 },
  { id: 'M105', name: 'Messier 105',                                                    distanceLy: 32000000 },
  { id: 'M106', name: 'Messier 106',                                                    distanceLy: 23700000 },
  { id: 'M107', name: 'Messier 107',                                                    distanceLy: 20900 },
  { id: 'M108', name: 'Surfboard Galaxy',                                               distanceLy: 45900000 },
  { id: 'M109', name: 'Messier 109',                                                    distanceLy: 83500000 },
  { id: 'M110', name: 'Messier 110',                                                    distanceLy: 2690000 },

  // ─── Popular NGC targets ──────────────────────────────────────────────────
  { id: 'NGC253',  name: 'Sculptor Galaxy',                                             distanceLy: 11400000 },
  { id: 'NGC281',  name: 'Pacman Nebula',           type: 'Emission Nebula',            distanceLy: 9500 },
  { id: 'NGC869',  name: 'Double Cluster (h Per)',                                      distanceLy: 7500 },
  { id: 'NGC884',  name: 'Double Cluster (χ Per)',                                      distanceLy: 7500 },
  { id: 'NGC891',  name: 'NGC 891',                                                     distanceLy: 27000000 },
  { id: 'NGC1499', name: 'California Nebula',       type: 'Emission Nebula',            distanceLy: 1000 },
  { id: 'NGC1977', name: 'Running Man Nebula',      type: 'Reflection Nebula',          distanceLy: 1500 },
  { id: 'NGC2024', name: 'Flame Nebula',            type: 'Emission Nebula',            distanceLy: 1350 },
  { id: 'NGC2174', name: 'Monkey Head Nebula',      type: 'Emission Nebula',            distanceLy: 6400 },
  { id: 'NGC2237', name: 'Rosette Nebula',          type: 'Emission Nebula',            distanceLy: 5200 },
  { id: 'NGC2244', name: 'Rosette Cluster',         type: 'Open Cluster',      constellation: 'Monoceros', ra: '06h 32m 24s', dec: '+04° 52′ 00″', distanceLy: 5200 },
  { id: 'NGC2264', name: 'Cone Nebula / Christmas Tree', type: 'Emission Nebula',       distanceLy: 2700 },
  { id: 'NGC2359', name: "Thor's Helmet",           type: 'Emission Nebula',            distanceLy: 15000 },
  { id: 'NGC2392', name: 'Eskimo Nebula',           type: 'Planetary Nebula',           distanceLy: 6500 },
  { id: 'NGC2903', name: 'NGC 2903',                                                    distanceLy: 30000000 },
  { id: 'NGC3372', name: 'Carina Nebula',           type: 'Emission Nebula',            distanceLy: 8500 },
  { id: 'NGC4565', name: 'Needle Galaxy',                                               distanceLy: 30000000 },
  { id: 'NGC5128', name: 'Centaurus A',                                                 distanceLy: 13000000 },
  { id: 'NGC5139', name: 'Omega Centauri',                                              distanceLy: 17090 },
  { id: 'NGC6543', name: "Cat's Eye Nebula",        type: 'Planetary Nebula',           distanceLy: 3300 },
  { id: 'NGC6888', name: 'Crescent Nebula',         type: 'Emission Nebula',            distanceLy: 5000 },
  { id: 'NGC6960', name: 'Western Veil Nebula',     type: 'Supernova Remnant',          distanceLy: 2400 },
  { id: 'NGC6992', name: 'Eastern Veil Nebula',     type: 'Supernova Remnant',          distanceLy: 2400 },
  { id: 'NGC7000', name: 'North America Nebula',    type: 'Emission Nebula',            distanceLy: 2590 },
  { id: 'NGC7009', name: 'Saturn Nebula',           type: 'Planetary Nebula',           distanceLy: 5000 },
  { id: 'NGC7023', name: 'Iris Nebula',             type: 'Reflection Nebula',          distanceLy: 1300 },
  { id: 'NGC7293', name: 'Helix Nebula',            type: 'Planetary Nebula',           distanceLy: 655 },
  { id: 'NGC7331', name: 'NGC 7331',                                                    distanceLy: 40000000 },
  { id: 'NGC7380', name: 'Wizard Nebula',           type: 'Emission Nebula',            distanceLy: 7200 },
  { id: 'NGC7635', name: 'Bubble Nebula',           type: 'Emission Nebula',            distanceLy: 7100 },
  { id: 'NGC7822', name: 'Cosmic Question Mark',    type: 'Emission Nebula',            distanceLy: 3000 },

  // ─── Popular IC targets ───────────────────────────────────────────────────
  { id: 'IC405',  name: 'Flaming Star Nebula',      type: 'Emission/Reflection Nebula', distanceLy: 1500 },
  { id: 'IC410',  name: 'Tadpoles Nebula',          type: 'Emission Nebula',            distanceLy: 12000 },
  { id: 'IC434',  name: 'Horsehead Nebula',         type: 'Dark Nebula',                distanceLy: 1500 },
  { id: 'IC1318', name: 'Sadr Region',              type: 'Emission Nebula',    constellation: 'Cygnus',   ra: '20h 22m 00s', dec: '+40° 19′ 00″', distanceLy: 3700 },
  { id: 'IC1396', name: 'Elephant Trunk Nebula',    type: 'Emission Nebula',            distanceLy: 2400 },
  { id: 'IC1805', name: 'Heart Nebula',             type: 'Emission Nebula',            distanceLy: 7500 },
  { id: 'IC1848', name: 'Soul Nebula',              type: 'Emission Nebula',            distanceLy: 7500 },
  { id: 'IC2118', name: 'Witch Head Nebula',        type: 'Reflection Nebula',  constellation: 'Eridanus', ra: '05h 02m 00s', dec: '-07° 54′ 00″', distanceLy: 800 },
  { id: 'IC5070', name: 'Pelican Nebula',           type: 'Emission Nebula',            distanceLy: 1800 },
  { id: 'IC5146', name: 'Cocoon Nebula',            type: 'Emission/Reflection Nebula', distanceLy: 4000 },

  // ─── Sharpless / Barnard (not in OpenNGC — full data required) ────────────
  { id: 'Sh2-101', name: 'Tulip Nebula',            type: 'Emission Nebula',  constellation: 'Cygnus',  ra: '19h 59m 30s', dec: '+35° 16′ 00″', distanceLy: 6000 },
  { id: 'Sh2-129', name: 'Flying Bat Nebula',       type: 'Emission Nebula',  constellation: 'Cepheus', ra: '21h 11m 48s', dec: '+59° 58′ 00″', distanceLy: 1300, description: 'A faint emission nebula in Cepheus that surrounds the rare Squid Nebula (Ou4), a bipolar planetary-scale outflow only visible in OIII.' },
  { id: 'Sh2-155', name: 'Cave Nebula',             type: 'Emission Nebula',  constellation: 'Cepheus', ra: '22h 56m 20s', dec: '+62° 37′ 30″', distanceLy: 2400 },
  { id: 'Sh2-240', name: 'Spaghetti Nebula',        type: 'Supernova Remnant', constellation: 'Taurus', ra: '05h 39m 00s', dec: '+28° 00′ 00″', distanceLy: 3000 },
  { id: 'B33',     name: 'Horsehead Nebula',        type: 'Dark Nebula',      constellation: 'Orion',   ra: '05h 40m 59s', dec: '-02° 27′ 30″', distanceLy: 1500 },

  // ─── Popular tier additions ──────────────────────────────────────────────
  // Objects in POPULAR_DSO_IDS not already covered above.

  // ── Additional emission / reflection nebulae ──────────────────────────────
  { id: 'NGC1432',  name: 'Maia Nebula',             type: 'Reflection Nebula' },
  { id: 'NGC1435',  name: 'Merope Nebula',            type: 'Reflection Nebula' },
  { id: 'NGC1893',  name: 'NGC 1893' },
  { id: 'NGC6334',  name: "Cat's Paw Nebula",         type: 'Emission Nebula',  distanceLy: 5500 },
  { id: 'NGC6357',  name: 'Lobster Nebula',           type: 'Emission Nebula',  distanceLy: 8000 },
  { id: 'NGC6559',  name: 'NGC 6559',                 type: 'Emission Nebula' },
  { id: 'NGC6914',  name: 'NGC 6914',                 type: 'Reflection Nebula' },
  { id: 'NGC7129',  name: 'NGC 7129',                 type: 'Reflection Nebula' },
  { id: 'NGC7538',  name: 'NGC 7538',                 type: 'Emission Nebula' },
  { id: 'IC417',    name: 'Spider Nebula',             type: 'Emission Nebula' },
  { id: 'IC443',    name: 'Jellyfish Nebula',          type: 'Supernova Remnant', distanceLy: 5000 },
  { id: 'IC2177',   name: 'Seagull Nebula',            type: 'Emission Nebula',  distanceLy: 3700 },
  { id: 'IC4628',   name: 'Prawn Nebula',              type: 'Emission Nebula',  distanceLy: 6000 },

  // ── Popular planetary nebulae ─────────────────────────────────────────────
  { id: 'NGC1535',  name: "Cleopatra's Eye",           type: 'Planetary Nebula' },
  { id: 'NGC2438',  name: 'NGC 2438',                  type: 'Planetary Nebula' },
  { id: 'NGC2818',  name: 'NGC 2818',                  type: 'Planetary Nebula' },
  { id: 'NGC6210',  name: 'Turtle Nebula',             type: 'Planetary Nebula' },
  { id: 'NGC6309',  name: 'Box Nebula',                type: 'Planetary Nebula' },
  { id: 'NGC6445',  name: 'NGC 6445',                  type: 'Planetary Nebula' },
  { id: 'NGC6781',  name: 'NGC 6781',                  type: 'Planetary Nebula' },
  { id: 'NGC6818',  name: 'Little Gem Nebula',         type: 'Planetary Nebula' },
  { id: 'NGC6905',  name: 'Blue Flash Nebula',         type: 'Planetary Nebula' },
  { id: 'NGC7027',  name: 'NGC 7027',                  type: 'Planetary Nebula' },

  // ── Popular galaxies ───────────────────────────────────────────────────────
  { id: 'NGC134',   name: 'NGC 134' },
  { id: 'NGC488',   name: 'NGC 488' },
  { id: 'NGC660',   name: 'NGC 660' },
  { id: 'NGC772',   name: 'NGC 772' },
  { id: 'NGC925',   name: 'NGC 925' },
  { id: 'NGC1023',  name: 'NGC 1023' },
  { id: 'NGC1232',  name: 'NGC 1232' },
  { id: 'NGC1300',  name: 'NGC 1300' },
  { id: 'NGC1365',  name: 'NGC 1365' },
  { id: 'NGC1380',  name: 'NGC 1380' },
  { id: 'NGC1531',  name: 'NGC 1531' },
  { id: 'NGC1532',  name: 'NGC 1532' },
  { id: 'NGC2207',  name: 'NGC 2207' },
  { id: 'NGC2683',  name: 'UFO Galaxy' },
  { id: 'NGC2841',  name: 'NGC 2841' },
  { id: 'NGC2997',  name: 'NGC 2997' },
  { id: 'NGC3344',  name: 'NGC 3344' },
  { id: 'NGC3377',  name: 'NGC 3377' },
  { id: 'NGC3486',  name: 'NGC 3486' },
  { id: 'NGC3521',  name: 'NGC 3521' },
  { id: 'NGC3628',  name: 'Hamburger Galaxy' },
  { id: 'NGC3953',  name: 'NGC 3953' },
  { id: 'NGC4051',  name: 'NGC 4051' },
  { id: 'NGC4214',  name: 'NGC 4214' },
  { id: 'NGC4216',  name: 'NGC 4216' },
  { id: 'NGC4274',  name: 'NGC 4274' },
  { id: 'NGC4395',  name: 'NGC 4395' },
  { id: 'NGC4490',  name: 'Cocoon Galaxy' },
  { id: 'NGC4517',  name: 'NGC 4517' },
  { id: 'NGC4535',  name: 'NGC 4535' },
  { id: 'NGC4567',  name: 'NGC 4567' },
  { id: 'NGC4568',  name: 'NGC 4568' },
  { id: 'NGC4651',  name: 'Umbrella Galaxy' },
  { id: 'NGC4666',  name: 'NGC 4666' },
  { id: 'NGC4725',  name: 'NGC 4725' },
  { id: 'NGC4762',  name: 'NGC 4762' },
  { id: 'NGC5033',  name: 'NGC 5033' },
  { id: 'NGC5101',  name: 'NGC 5101' },
  { id: 'NGC5364',  name: 'NGC 5364' },
  { id: 'NGC5474',  name: 'NGC 5474' },
  { id: 'NGC5746',  name: 'NGC 5746' },
  { id: 'NGC5905',  name: 'NGC 5905' },
  { id: 'NGC5907',  name: 'Splinter Galaxy' },
  { id: 'NGC7184',  name: 'NGC 7184' },
  { id: 'NGC7793',  name: 'NGC 7793' },
  { id: 'IC10',     name: 'IC 10' },

  // ── Popular star clusters ─────────────────────────────────────────────────
  { id: 'NGC957',   name: 'NGC 957' },
  { id: 'NGC1027',  name: 'NGC 1027' },
  { id: 'NGC1245',  name: 'NGC 1245' },
  { id: 'NGC1342',  name: 'NGC 1342' },
  { id: 'NGC1502',  name: 'NGC 1502' },
  { id: 'NGC1528',  name: 'NGC 1528' },
  { id: 'NGC1647',  name: 'NGC 1647' },
  { id: 'NGC1664',  name: 'NGC 1664' },
  { id: 'NGC1907',  name: 'NGC 1907' },
  { id: 'NGC2169',  name: '37 Cluster' },
  { id: 'NGC2266',  name: 'NGC 2266' },
  { id: 'NGC2451',  name: 'NGC 2451' },
  { id: 'NGC2547',  name: 'NGC 2547' },
  { id: 'NGC6633',  name: 'NGC 6633' },
  { id: 'IC4756',   name: 'IC 4756' },

  // ─── Extended tier (Herschel 400) ────────────────────────────────────────
  // ── Galaxies ───────────────────────────────────────────────────────────────
  { id: 'NGC278',   name: 'NGC 278' },
  { id: 'NGC404',   name: "Mirach's Ghost" },
  { id: 'NGC524',   name: 'NGC 524' },
  { id: 'NGC584',   name: 'NGC 584' },
  { id: 'NGC596',   name: 'NGC 596' },
  { id: 'NGC613',   name: 'NGC 613' },
  { id: 'NGC615',   name: 'NGC 615' },
  { id: 'NGC720',   name: 'NGC 720' },
  { id: 'NGC779',   name: 'NGC 779' },
  { id: 'NGC908',   name: 'NGC 908' },
  { id: 'NGC936',   name: 'NGC 936' },
  { id: 'NGC1022',  name: 'NGC 1022' },
  { id: 'NGC1052',  name: 'NGC 1052' },
  { id: 'NGC1055',  name: 'NGC 1055' },
  { id: 'NGC1084',  name: 'NGC 1084' },
  { id: 'NGC1407',  name: 'NGC 1407' },
  { id: 'NGC1961',  name: 'NGC 1961' },
  { id: 'NGC1964',  name: 'NGC 1964' },
  { id: 'NGC2613',  name: 'NGC 2613' },
  { id: 'NGC2655',  name: 'NGC 2655' },
  { id: 'NGC2681',  name: 'NGC 2681' },
  { id: 'NGC2742',  name: 'NGC 2742' },
  { id: 'NGC2768',  name: 'NGC 2768' },
  { id: 'NGC2787',  name: 'NGC 2787' },
  { id: 'NGC2811',  name: 'NGC 2811' },
  { id: 'NGC2859',  name: 'NGC 2859' },
  { id: 'NGC2950',  name: 'NGC 2950' },
  { id: 'NGC2964',  name: 'NGC 2964' },
  { id: 'NGC2974',  name: 'NGC 2974' },
  { id: 'NGC2976',  name: 'NGC 2976' },
  { id: 'NGC2985',  name: 'NGC 2985' },
  { id: 'NGC3077',  name: 'NGC 3077' },
  { id: 'NGC3079',  name: 'NGC 3079' },
  { id: 'NGC3147',  name: 'NGC 3147' },
  { id: 'NGC3166',  name: 'NGC 3166' },
  { id: 'NGC3169',  name: 'NGC 3169' },
  { id: 'NGC3184',  name: 'NGC 3184' },
  { id: 'NGC3193',  name: 'NGC 3193' },
  { id: 'NGC3198',  name: 'NGC 3198' },
  { id: 'NGC3227',  name: 'NGC 3227' },
  { id: 'NGC3245',  name: 'NGC 3245' },
  { id: 'NGC3277',  name: 'NGC 3277' },
  { id: 'NGC3294',  name: 'NGC 3294' },
  { id: 'NGC3310',  name: 'NGC 3310' },
  { id: 'NGC3384',  name: 'NGC 3384' },
  { id: 'NGC3412',  name: 'NGC 3412' },
  { id: 'NGC3414',  name: 'NGC 3414' },
  { id: 'NGC3432',  name: 'NGC 3432' },
  { id: 'NGC3489',  name: 'NGC 3489' },
  { id: 'NGC3593',  name: 'NGC 3593' },
  { id: 'NGC3607',  name: 'NGC 3607' },
  { id: 'NGC3608',  name: 'NGC 3608' },
  { id: 'NGC3610',  name: 'NGC 3610' },
  { id: 'NGC3613',  name: 'NGC 3613' },
  { id: 'NGC3621',  name: 'NGC 3621' },
  { id: 'NGC3631',  name: 'NGC 3631' },
  { id: 'NGC3640',  name: 'NGC 3640' },
  { id: 'NGC3655',  name: 'NGC 3655' },
  { id: 'NGC3665',  name: 'NGC 3665' },
  { id: 'NGC3675',  name: 'NGC 3675' },
  { id: 'NGC3686',  name: 'NGC 3686' },
  { id: 'NGC3726',  name: 'NGC 3726' },
  { id: 'NGC3729',  name: 'NGC 3729' },
  { id: 'NGC3810',  name: 'NGC 3810' },
  { id: 'NGC3813',  name: 'NGC 3813' },
  { id: 'NGC3877',  name: 'NGC 3877' },
  { id: 'NGC3893',  name: 'NGC 3893' },
  { id: 'NGC3898',  name: 'NGC 3898' },
  { id: 'NGC3900',  name: 'NGC 3900' },
  { id: 'NGC3938',  name: 'NGC 3938' },
  { id: 'NGC3941',  name: 'NGC 3941' },
  { id: 'NGC3945',  name: 'NGC 3945' },
  { id: 'NGC3949',  name: 'NGC 3949' },
  { id: 'NGC3962',  name: 'NGC 3962' },
  { id: 'NGC3982',  name: 'NGC 3982' },
  { id: 'NGC3998',  name: 'NGC 3998' },
  { id: 'NGC4026',  name: 'NGC 4026' },
  { id: 'NGC4027',  name: 'NGC 4027' },
  { id: 'NGC4030',  name: 'NGC 4030' },
  { id: 'NGC4036',  name: 'NGC 4036' },
  { id: 'NGC4041',  name: 'NGC 4041' },
  { id: 'NGC4088',  name: 'NGC 4088' },
  { id: 'NGC4102',  name: 'NGC 4102' },
  { id: 'NGC4111',  name: 'NGC 4111' },
  { id: 'NGC4150',  name: 'NGC 4150' },
  { id: 'NGC4151',  name: 'NGC 4151' },
  { id: 'NGC4179',  name: 'NGC 4179' },
  { id: 'NGC4203',  name: 'NGC 4203' },
  { id: 'NGC4245',  name: 'NGC 4245' },
  { id: 'NGC4251',  name: 'NGC 4251' },
  { id: 'NGC4261',  name: 'NGC 4261' },
  { id: 'NGC4273',  name: 'NGC 4273' },
  { id: 'NGC4278',  name: 'NGC 4278' },
  { id: 'NGC4281',  name: 'NGC 4281' },
  { id: 'NGC4293',  name: 'NGC 4293' },
  { id: 'NGC4314',  name: 'NGC 4314' },
  { id: 'NGC4350',  name: 'NGC 4350' },
  { id: 'NGC4365',  name: 'NGC 4365' },
  { id: 'NGC4371',  name: 'NGC 4371' },
  { id: 'NGC4394',  name: 'NGC 4394' },
  { id: 'NGC4414',  name: 'NGC 4414' },
  { id: 'NGC4419',  name: 'NGC 4419' },
  { id: 'NGC4429',  name: 'NGC 4429' },
  { id: 'NGC4435',  name: 'NGC 4435' },
  { id: 'NGC4438',  name: 'NGC 4438' },
  { id: 'NGC4442',  name: 'NGC 4442' },
  { id: 'NGC4448',  name: 'NGC 4448' },
  { id: 'NGC4450',  name: 'NGC 4450' },
  { id: 'NGC4459',  name: 'NGC 4459' },
  { id: 'NGC4473',  name: 'NGC 4473' },
  { id: 'NGC4477',  name: 'NGC 4477' },
  { id: 'NGC4478',  name: 'NGC 4478' },
  { id: 'NGC4494',  name: 'NGC 4494' },
  { id: 'NGC4526',  name: 'NGC 4526' },
  { id: 'NGC4527',  name: 'NGC 4527' },
  { id: 'NGC4546',  name: 'NGC 4546' },
  { id: 'NGC4564',  name: 'NGC 4564' },
  { id: 'NGC4570',  name: 'NGC 4570' },
  { id: 'NGC4596',  name: 'NGC 4596' },
  { id: 'NGC4618',  name: 'NGC 4618' },
  { id: 'NGC4636',  name: 'NGC 4636' },
  { id: 'NGC4643',  name: 'NGC 4643' },
  { id: 'NGC4654',  name: 'NGC 4654' },
  { id: 'NGC4660',  name: 'NGC 4660' },
  { id: 'NGC4689',  name: 'NGC 4689' },
  { id: 'NGC4698',  name: 'NGC 4698' },
  { id: 'NGC4699',  name: 'NGC 4699' },
  { id: 'NGC4753',  name: 'NGC 4753' },
  { id: 'NGC4754',  name: 'NGC 4754' },
  { id: 'NGC4772',  name: 'NGC 4772' },
  { id: 'NGC4781',  name: 'NGC 4781' },
  { id: 'NGC4845',  name: 'NGC 4845' },
  { id: 'NGC4866',  name: 'NGC 4866' },
  { id: 'NGC4900',  name: 'NGC 4900' },
  { id: 'NGC4958',  name: 'NGC 4958' },
  { id: 'NGC4995',  name: 'NGC 4995' },
  { id: 'NGC5054',  name: 'NGC 5054' },
  { id: 'NGC5077',  name: 'NGC 5077' },
  { id: 'NGC5084',  name: 'NGC 5084' },
  { id: 'NGC5102',  name: 'NGC 5102' },
  { id: 'NGC5195',  name: 'NGC 5195' },
  { id: 'NGC5322',  name: 'NGC 5322' },
  { id: 'NGC5363',  name: 'NGC 5363' },
  { id: 'NGC5377',  name: 'NGC 5377' },
  { id: 'NGC5473',  name: 'NGC 5473' },
  { id: 'NGC5557',  name: 'NGC 5557' },
  { id: 'NGC5566',  name: 'NGC 5566' },
  { id: 'NGC5576',  name: 'NGC 5576' },
  { id: 'NGC5638',  name: 'NGC 5638' },
  { id: 'NGC5643',  name: 'NGC 5643' },
  { id: 'NGC5813',  name: 'NGC 5813' },
  { id: 'NGC5831',  name: 'NGC 5831' },
  { id: 'NGC5838',  name: 'NGC 5838' },
  { id: 'NGC5846',  name: 'NGC 5846' },
  { id: 'NGC5866',  name: 'NGC 5866' },
  { id: 'NGC5982',  name: 'NGC 5982' },
  { id: 'NGC6118',  name: 'NGC 6118' },
  { id: 'NGC6207',  name: 'NGC 6207' },
  { id: 'NGC7217',  name: 'NGC 7217' },
  { id: 'NGC7448',  name: 'NGC 7448' },
  { id: 'NGC7606',  name: 'NGC 7606' },
  { id: 'NGC7619',  name: 'NGC 7619' },
  { id: 'NGC7626',  name: 'NGC 7626' },
  { id: 'NGC7723',  name: 'NGC 7723' },
  { id: 'NGC7727',  name: 'NGC 7727' },

  // ── Star clusters ─────────────────────────────────────────────────────────
  { id: 'NGC129',   name: 'NGC 129' },
  { id: 'NGC136',   name: 'NGC 136' },
  { id: 'NGC225',   name: 'NGC 225' },
  { id: 'NGC288',   name: 'NGC 288' },
  { id: 'NGC381',   name: 'NGC 381' },
  { id: 'NGC436',   name: 'NGC 436' },
  { id: 'NGC637',   name: 'NGC 637' },
  { id: 'NGC654',   name: 'NGC 654' },
  { id: 'NGC659',   name: 'NGC 659' },
  { id: 'NGC1444',  name: 'NGC 1444' },
  { id: 'NGC1513',  name: 'NGC 1513' },
  { id: 'NGC1545',  name: 'NGC 1545' },
  { id: 'NGC1817',  name: 'NGC 1817' },
  { id: 'NGC1857',  name: 'NGC 1857' },
  { id: 'NGC1931',  name: 'NGC 1931' },
  { id: 'NGC1980',  name: 'NGC 1980' },
  { id: 'NGC2126',  name: 'NGC 2126' },
  { id: 'NGC2129',  name: 'NGC 2129' },
  { id: 'NGC2158',  name: 'NGC 2158' },
  { id: 'NGC2186',  name: 'NGC 2186' },
  { id: 'NGC2194',  name: 'NGC 2194' },
  { id: 'NGC2204',  name: 'NGC 2204' },
  { id: 'NGC2215',  name: 'NGC 2215' },
  { id: 'NGC2232',  name: 'NGC 2232' },
  { id: 'NGC2251',  name: 'NGC 2251' },
  { id: 'NGC2281',  name: 'NGC 2281' },
  { id: 'NGC2286',  name: 'NGC 2286' },
  { id: 'NGC2301',  name: 'Great Bird Cluster' },
  { id: 'NGC2304',  name: 'NGC 2304' },
  { id: 'NGC2311',  name: 'NGC 2311' },
  { id: 'NGC2324',  name: 'NGC 2324' },
  { id: 'NGC2335',  name: 'NGC 2335' },
  { id: 'NGC2343',  name: 'NGC 2343' },
  { id: 'NGC2353',  name: 'NGC 2353' },
  { id: 'NGC2354',  name: 'NGC 2354' },
  { id: 'NGC2355',  name: 'NGC 2355' },
  { id: 'NGC2395',  name: 'NGC 2395' },
  { id: 'NGC2420',  name: 'NGC 2420' },
  { id: 'NGC2421',  name: 'NGC 2421' },
  { id: 'NGC2423',  name: 'NGC 2423' },
  { id: 'NGC2479',  name: 'NGC 2479' },
  { id: 'NGC2482',  name: 'NGC 2482' },
  { id: 'NGC2489',  name: 'NGC 2489' },
  { id: 'NGC2509',  name: 'NGC 2509' },
  { id: 'NGC2539',  name: 'NGC 2539' },
  { id: 'NGC2567',  name: 'NGC 2567' },
  { id: 'NGC2571',  name: 'NGC 2571' },
  { id: 'NGC2627',  name: 'NGC 2627' },
  { id: 'NGC4147',  name: 'NGC 4147' },
  { id: 'NGC5466',  name: 'NGC 5466' },
  { id: 'NGC5634',  name: 'NGC 5634' },
  { id: 'NGC5897',  name: 'NGC 5897' },
  { id: 'NGC6229',  name: 'NGC 6229' },
  { id: 'NGC6235',  name: 'NGC 6235' },
  { id: 'NGC6284',  name: 'NGC 6284' },
  { id: 'NGC6287',  name: 'NGC 6287' },
  { id: 'NGC6293',  name: 'NGC 6293' },
  { id: 'NGC6304',  name: 'NGC 6304' },
  { id: 'NGC6316',  name: 'NGC 6316' },
  { id: 'NGC6342',  name: 'NGC 6342' },
  { id: 'NGC6355',  name: 'NGC 6355' },
  { id: 'NGC6356',  name: 'NGC 6356' },
  { id: 'NGC6401',  name: 'NGC 6401' },
  { id: 'NGC6426',  name: 'NGC 6426' },
  { id: 'NGC6440',  name: 'NGC 6440' },
  { id: 'NGC6451',  name: 'NGC 6451' },
  { id: 'NGC6517',  name: 'NGC 6517' },
  { id: 'NGC6522',  name: 'NGC 6522' },
  { id: 'NGC6528',  name: 'NGC 6528' },
  { id: 'NGC6540',  name: 'NGC 6540' },
  { id: 'NGC6544',  name: 'NGC 6544' },
  { id: 'NGC6553',  name: 'NGC 6553' },
  { id: 'NGC6568',  name: 'NGC 6568' },
  { id: 'NGC6569',  name: 'NGC 6569' },
  { id: 'NGC6584',  name: 'NGC 6584' },
  { id: 'NGC6604',  name: 'NGC 6604' },
  { id: 'NGC6638',  name: 'NGC 6638' },
  { id: 'NGC6642',  name: 'NGC 6642' },
  { id: 'NGC6645',  name: 'NGC 6645' },
  { id: 'NGC6664',  name: 'NGC 6664' },
  { id: 'NGC6712',  name: 'NGC 6712' },
  { id: 'NGC6717',  name: 'NGC 6717' },
  { id: 'NGC6723',  name: 'NGC 6723' },
  { id: 'NGC6760',  name: 'NGC 6760' },
  { id: 'NGC6802',  name: 'NGC 6802' },
  { id: 'NGC6823',  name: 'NGC 6823' },
  { id: 'NGC6830',  name: 'NGC 6830' },
  { id: 'NGC6834',  name: 'NGC 6834' },
  { id: 'NGC6866',  name: 'NGC 6866' },
  { id: 'NGC6910',  name: 'NGC 6910' },
  { id: 'NGC6939',  name: 'NGC 6939' },
  { id: 'NGC6940',  name: 'NGC 6940' },
  { id: 'NGC7044',  name: 'NGC 7044' },
  { id: 'NGC7062',  name: 'NGC 7062' },
  { id: 'NGC7086',  name: 'NGC 7086' },
  { id: 'NGC7128',  name: 'NGC 7128' },
  { id: 'NGC7142',  name: 'NGC 7142' },
  { id: 'NGC7160',  name: 'NGC 7160' },
  { id: 'NGC7209',  name: 'NGC 7209' },
  { id: 'NGC7261',  name: 'NGC 7261' },
  { id: 'NGC7510',  name: 'NGC 7510' },
  { id: 'NGC7686',  name: 'NGC 7686' },
  { id: 'NGC7789',  name: "Caroline's Rose" },

  // ── Nebulae / planetary nebulae ───────────────────────────────────────────
  { id: 'NGC1501',  name: 'NGC 1501',               type: 'Planetary Nebula' },
  { id: 'NGC1788',  name: 'NGC 1788',               type: 'Reflection Nebula' },
  { id: 'NGC1999',  name: 'NGC 1999',               type: 'Reflection Nebula' },
  { id: 'NGC2022',  name: 'NGC 2022',               type: 'Planetary Nebula' },
  { id: 'NGC2371',  name: 'NGC 2371',               type: 'Planetary Nebula' },
  { id: 'NGC2440',  name: 'NGC 2440',               type: 'Planetary Nebula' },
  { id: 'NGC4361',  name: 'NGC 4361',               type: 'Planetary Nebula' },
  { id: 'NGC6369',  name: 'Little Ghost Nebula',    type: 'Planetary Nebula' },
  { id: 'NGC6572',  name: 'NGC 6572',               type: 'Planetary Nebula' },
  { id: 'NGC6629',  name: 'NGC 6629',               type: 'Planetary Nebula' },
  { id: 'NGC6741',  name: 'Phantom Streak Nebula',  type: 'Planetary Nebula' },
  { id: 'NGC6745',  name: 'NGC 6745' },
  { id: 'NGC6790',  name: 'NGC 6790',               type: 'Planetary Nebula' },
  { id: 'NGC7008',  name: 'NGC 7008',               type: 'Planetary Nebula' },
  { id: 'NGC7026',  name: 'NGC 7026',               type: 'Planetary Nebula' },
];

// ─── OpenNGC lookup ─────────────────────────────────────────────────────────

const openNgcRaw = JSON.parse(fs.readFileSync(OPENNGC_PATH, 'utf8'));
const openNgcById = new Map();
const openNgcByMessier = new Map();
for (const e of openNgcRaw) {
  openNgcById.set(String(e.id).toUpperCase(), e);
  if (e.messier != null) openNgcByMessier.set(`M${e.messier}`.toUpperCase(), e);
}

function lookupOpenNGC(id) {
  const key = id.toUpperCase().replace(/\s+/g, '');
  if (openNgcById.has(key)) return openNgcById.get(key);
  // Zero-pad NGC/IC numbers (NGC253 → NGC0253)
  const m = key.match(/^(NGC|IC)(\d{1,3})$/);
  if (m) {
    const padded = `${m[1]}${m[2].padStart(4, '0')}`;
    if (openNgcById.has(padded)) return openNgcById.get(padded);
  }
  if (key.startsWith('M') && openNgcByMessier.has(key)) return openNgcByMessier.get(key);
  return null;
}

// ─── RA / Dec sexagesimal formatting ─────────────────────────────────────────

function raToSexagesimal(decimalHours) {
  const h = Math.floor(decimalHours);
  const mFloat = (decimalHours - h) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1)}s`;
}

function decToSexagesimal(decimalDeg) {
  const sign = decimalDeg < 0 ? '-' : '+';
  const abs = Math.abs(decimalDeg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${String(Math.round(s)).padStart(2, '0')}″`;
}

// ─── Wikipedia summary fetch ─────────────────────────────────────────────────

const USER_AGENT = 'Nebulis/1.0 (https://github.com/nebulis; catalog enrichment script)';

async function fetchWikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.type === 'disambiguation') return null;
    if (typeof json.extract !== 'string' || json.extract.length < 40) return null;
    return { extract: json.extract, wikiUrl: json.content_urls?.desktop?.page ?? null };
  } catch {
    return null;
  }
}

function trimExtract(extract) {
  const cleaned = extract.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 280) return cleaned;
  const sentences = (cleaned.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [])
    .map(s => s.trim())
    .filter(s => s.length >= 12 && /^[A-Za-z"'"]/.test(s));
  if (sentences.length === 0) return cleaned.slice(0, 280) + '…';
  let out = sentences[0];
  if (sentences.length > 1 && (out + ' ' + sentences[1]).length <= 320) {
    out = out + ' ' + sentences[1];
  }
  return out;
}

function parseDistanceLy(text) {
  const bly = text.match(/(\d+(?:\.\d+)?)\s*billion\s+light[- ]years?/i);
  if (bly) return Math.round(parseFloat(bly[1]) * 1_000_000_000);
  const mly = text.match(/(\d+(?:\.\d+)?)\s*million\s+light[- ]years?/i);
  if (mly) return Math.round(parseFloat(mly[1]) * 1_000_000);
  const ly = text.match(/([\d,]+(?:\.\d+)?)\s+light[- ]years?/i);
  if (ly) return Math.round(parseFloat(ly[1].replace(/,/g, '')));
  const mpc = text.match(/(\d+(?:\.\d+)?)\s*Mpc\b/);
  if (mpc) return Math.round(parseFloat(mpc[1]) * 3_262_000);
  const kpc = text.match(/(\d+(?:\.\d+)?)\s*kpc\b/);
  if (kpc) return Math.round(parseFloat(kpc[1]) * 3_262);
  return null;
}

function candidateTitles(entry) {
  const titles = [];
  const m = entry.id.match(/^M(\d+)$/);
  if (m) titles.push(`Messier ${m[1]}`);
  const ngc = entry.id.match(/^(NGC|IC)(\d+)$/);
  if (ngc) titles.push(`${ngc[1]} ${ngc[2]}`);
  const isGenericMessier = /^Messier \d+$/.test(entry.name);
  if (entry.name && !isGenericMessier && entry.name !== entry.id) titles.push(entry.name);
  titles.push(entry.id);
  return [...new Set(titles)];
}

// ─── Per-entry merge ─────────────────────────────────────────────────────────

function mergeOpenNGC(stub) {
  const ngc = lookupOpenNGC(stub.id);
  const merged = { ...stub };
  if (!ngc) return merged;
  if (merged.type == null) merged.type = ngc.type ?? 'Unknown';
  if (merged.constellation == null) merged.constellation = ngc.constellation ?? 'Unknown';
  if (merged.magnitude == null && typeof ngc.magnitude === 'number') merged.magnitude = ngc.magnitude;
  if (merged.ra == null && ngc.ra != null) merged.ra = raToSexagesimal(Number(ngc.ra));
  if (merged.dec == null && ngc.dec != null) merged.dec = decToSexagesimal(Number(ngc.dec));
  return merged;
}

async function enrichEntry(stub) {
  const merged = mergeOpenNGC(stub);
  // Defaults so the resulting JSON always has these fields.
  if (merged.constellation == null) merged.constellation = 'Unknown';
  if (merged.type == null) merged.type = 'Unknown';
  if (merged.description == null) merged.description = '';
  // Preserve the stub-provided description as the fallback when Wikipedia
  // doesn't return anything later. We only set defaults here; the Wikipedia
  // fetch below will override description if it succeeds.

  let wikiHit = null;
  for (const title of candidateTitles(merged)) {
    const result = await fetchWikiSummary(title);
    if (result) { wikiHit = { title, ...result }; break; }
  }
  if (wikiHit) {
    merged.description = trimExtract(wikiHit.extract);
    merged.wikiUrl = wikiHit.wikiUrl;
    if (merged.distanceLy == null) {
      const parsed = parseDistanceLy(wikiHit.extract);
      if (parsed != null) merged.distanceLy = parsed;
    }
  }

  return { merged, wikiHit };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Building catalog-curated.json from ${entries.length} entries…`);
  const out = [];
  let hits = 0;
  let openNgcMisses = [];
  for (const stub of entries) {
    const { merged, wikiHit } = await enrichEntry(stub);
    out.push(merged);
    if (wikiHit) {
      hits++;
      console.log(`  ✓ ${stub.id.padEnd(8)} ${wikiHit.title}`);
    } else {
      console.log(`  · ${stub.id.padEnd(8)} (kept fallback description)`);
    }
    if (!lookupOpenNGC(stub.id) && !stub.ra) openNgcMisses.push(stub.id);
    await new Promise(r => setTimeout(r, 80));
  }

  // Order keys consistently in the output for readable diffs.
  const ordered = out.map(e => ({
    id: e.id,
    name: e.name,
    type: e.type,
    constellation: e.constellation,
    magnitude: e.magnitude,
    description: e.description,
    ra: e.ra,
    dec: e.dec,
    distanceLy: e.distanceLy,
    wikiUrl: e.wikiUrl ?? null,
  }));

  fs.writeFileSync(OUT_PATH, JSON.stringify(ordered, null, 2) + '\n');
  console.log(`\nWrote ${ordered.length} entries to ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log(`Wikipedia hits: ${hits} / ${entries.length}`);
  if (openNgcMisses.length > 0) {
    console.log(`Note: ${openNgcMisses.length} entries had no OpenNGC match and no manual ra/dec: ${openNgcMisses.join(', ')}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
