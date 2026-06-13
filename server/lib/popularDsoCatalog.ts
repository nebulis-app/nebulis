/**
 * Popular DSO catalog — curated list of ~100 well-known NGC/IC deep-sky
 * objects that are NOT already covered by Messier (Phase 1 DSS2 + Phase 2
 * Wikipedia) or Caldwell (Phase 3 NASA Hubble).
 *
 * Picked for SeeStar smart-telescope users specifically:
 *   - Wide-field framing-friendly (~250 mm focal length)
 *   - Bright enough for short integrations
 *   - Heavy bias toward emission nebulae (duo-band filter friendly) and
 *     famous bright galaxies that show up on every "best DSO for smart
 *     telescopes" list
 *
 * IDs are normalized: uppercase, no whitespace — matching how the prefetch
 * job and `<ID>_master.jpg` filenames are formed.
 *
 * Adding to this list is cheap: each entry costs one DSS2 fetch from
 * alasky (~3–44 s under load) plus one Wikipedia summary lookup. Removing
 * an entry doesn't delete its cached files — those persist until a
 * `wipe-cache` admin call.
 *
 * If a future scope ("popular", say) is desired separate from "curated",
 * promote this Set into a separate scope filter rather than expanding the
 * curated set further.
 */

export const POPULAR_DSO_IDS: ReadonlySet<string> = new Set([
  // ── Emission & reflection nebulae ─────────────────────────────────────
  // Narrowband-friendly bright HII regions; the bread and butter of
  // SeeStar duo-band imaging.
  'NGC281',   // Pacman Nebula
  'NGC1432',  // Maia Nebula (Pleiades reflection)
  'NGC1435',  // Merope Nebula (Pleiades reflection)
  'NGC1499',  // California Nebula
  'NGC1893',  // open cluster + emission (with IC 410 Tadpoles)
  'NGC1977',  // Running Man Nebula (Orion)
  'NGC2174',  // Monkey Head Nebula
  'NGC2264',  // Christmas Tree / Cone Nebula
  'NGC2359',  // Thor's Helmet
  'NGC6334',  // Cat's Paw Nebula
  'NGC6357',  // Lobster Nebula
  'NGC6559',  // diffuse nebula in Sagittarius
  'NGC6914',  // reflection nebula in Cygnus
  'NGC7129',  // reflection nebula complex
  'NGC7380',  // Wizard Nebula
  'NGC7538',  // emission nebula in Cassiopeia
  'NGC7822',  // emission complex in Cepheus
  'IC410',    // Tadpoles (with NGC 1893)
  'IC417',    // Spider Nebula
  'IC434',    // Horsehead Nebula region
  'IC443',    // Jellyfish Nebula
  'IC1318',   // Sadr / Butterfly region
  'IC1396',   // Elephant's Trunk
  'IC1805',   // Heart Nebula
  'IC1848',   // Soul Nebula
  'IC2118',   // Witch Head Nebula
  'IC2177',   // Seagull Nebula
  'IC4628',   // Prawn Nebula
  'IC5070',   // Pelican Nebula

  // ── Planetary nebulae ─────────────────────────────────────────────────
  'NGC1535',  // Cleopatra's Eye
  'NGC2438',  // planetary in M46 field
  'NGC2818',  // planetary in open cluster
  'NGC6210',  // Turtle Nebula
  'NGC6309',  // Box Nebula
  'NGC6445',  // Crescent (planetary)
  'NGC6781',  // Aquila planetary
  'NGC6818',  // Little Gem
  'NGC6905',  // Blue Flash
  'NGC7027',  // Pink Pillow / Magic Carpet

  // ── Galaxies (non-Messier, non-Caldwell) ──────────────────────────────
  // The "second tier" of bright/famous galaxies most amateurs work through
  // after exhausting Messier + Caldwell.
  'NGC134',
  'NGC488',
  'NGC660',   // polar ring galaxy
  'NGC772',
  'NGC925',
  'NGC1023',
  'NGC1232',
  'NGC1300',  // textbook barred spiral
  'NGC1365',  // Great Barred Spiral (Fornax cluster)
  'NGC1380',
  'NGC1531',  // interacting with NGC 1532
  'NGC1532',
  'NGC2207',  // interacting with IC 2163
  'NGC2683',  // UFO Galaxy
  'NGC2841',
  'NGC2903',
  'NGC2997',
  'NGC3344',
  'NGC3377',
  'NGC3486',
  'NGC3521',
  'NGC3628',  // Hamburger Galaxy (Leo Triplet)
  'NGC3953',
  'NGC4051',
  'NGC4214',
  'NGC4216',
  'NGC4274',
  'NGC4395',  // low surface brightness Sd
  'NGC4490',  // Cocoon Galaxy (with NGC 4485)
  'NGC4517',
  'NGC4535',
  'NGC4567',  // Siamese Twins (with NGC 4568)
  'NGC4568',
  'NGC4651',  // Umbrella Galaxy
  'NGC4666',
  'NGC4725',
  'NGC4762',
  'NGC5033',
  'NGC5101',
  'NGC5364',
  'NGC5474',  // distorted, paired with M101
  'NGC5746',
  'NGC5905',
  'NGC5907',  // Splinter Galaxy
  'NGC7184',
  'NGC7793',  // Sculptor group dwarf spiral
  'IC10',     // local group dwarf irregular

  // ── Star clusters (open + globular) ───────────────────────────────────
  'NGC957',
  'NGC1027',
  'NGC1245',
  'NGC1342',
  'NGC1502',  // anchor of Kemble's Cascade
  'NGC1528',
  'NGC1647',
  'NGC1664',
  'NGC1907',
  'NGC2169',  // 37 Cluster
  'NGC2266',
  'NGC2451',
  'NGC2547',
  'NGC6633',  // popular open cluster paired with IC 4756
  'IC4756',
]);
