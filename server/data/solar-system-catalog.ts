/**
 * Solar system object catalog.
 *
 * Provides catalog entries for the Sun, all planets, notable moons, and dwarf
 * planets so that import folder matching and image prefetch work for solar
 * system targets — the same way they work for deep-sky objects.
 *
 * Keys in SOLAR_SYSTEM_MAP are UPPERCASE with spaces stripped (matching
 * lookupCatalogEntry's normalisation). SOLAR_SYSTEM_LOOKUP_KEYS are lowercase
 * (matching isSolarSystemObject's normalisation in skyImage.ts).
 */

import type { CatalogEntry } from '../lib/types/catalog.js';

interface SolarEntry extends CatalogEntry {
  /** NASA Image Library search string for this object. */
  nasaSearchTerm: string;
  /** Additional lowercase keys (no spaces) that should resolve to this entry. */
  aliases?: string[];
  /** Direct image URL scraped from astrobackyard.com/planets-in-order/ */
  astroBackyardUrl?: string;
}

const entries: SolarEntry[] = [
  // ── Star ─────────────────────────────────────────────────────────────────
  {
    id: 'Sun',
    name: 'The Sun',
    type: 'Star',
    constellation: '',
    magnitude: -26.74,
    description:
      'The Sun is the star at the center of our solar system with a surface temperature of about 5,500°C. In white light, sunspots appear as darker regions against the photosphere. H-alpha imaging reveals prominences, filaments, and flares invisible to white-light observers. A proper solar filter is required for all solar observation.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Sun',
    nasaSearchTerm: 'sun solar dynamics observatory',
    aliases: ['sol', 'solar'],
  },

  // ── Planets ───────────────────────────────────────────────────────────────
  {
    id: 'Mercury',
    name: 'Mercury',
    type: 'Planet',
    constellation: '',
    magnitude: -2.48,
    description:
      'Mercury is the smallest planet, completing an orbit in just 88 days. Like the Moon it displays phases through a telescope, cycling from a large thin crescent near inferior conjunction to a smaller gibbous disk near superior conjunction. It spans 5 to 13 arcseconds and is always within 28 degrees of the Sun, requiring careful observation at twilight.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Mercury_(planet)',
    nasaSearchTerm: 'mercury planet messenger',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Mercury.jpg',
  },
  {
    id: 'Venus',
    name: 'Venus',
    type: 'Planet',
    constellation: '',
    magnitude: -4.92,
    description:
      'Venus is the brightest planet, perpetually shrouded in reflective sulfuric acid clouds. It shows dramatic phases, ranging from a large thin crescent at inferior conjunction to a smaller full disk near superior conjunction. At its largest it spans over 60 arcseconds, and the atmospheric glow around the limb is visible in UV-filtered imaging.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Venus',
    nasaSearchTerm: 'venus planet magellan',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Venus.jpg',
  },
  {
    id: 'Mars',
    name: 'Mars',
    type: 'Planet',
    constellation: '',
    magnitude: -2.91,
    description:
      'Mars reaches 14 to 25 arcseconds at opposition, revealing polar ice caps, dark albedo markings like Syrtis Major, and the vast Hellas impact basin. Surface detail changes seasonally, and global dust storms can obscure the disk for months. Opposition occurs roughly every 26 months; southern-hemisphere oppositions favour the largest disks from mid-latitudes.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Mars',
    nasaSearchTerm: 'mars planet hubble',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Mars.jpg',
  },
  {
    id: 'Jupiter',
    name: 'Jupiter',
    type: 'Planet',
    constellation: '',
    magnitude: -2.94,
    description:
      'Jupiter is the largest planet, with a disk spanning 30 to 50 arcseconds at opposition. Cloud bands, the Great Red Spot, and the shadow transits of the four Galilean moons are visible in modest instruments. The moon configuration changes noticeably over just a few hours, and belt outbreaks can dramatically alter the disk appearance from month to month.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Jupiter',
    nasaSearchTerm: 'jupiter planet hubble',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Jupiter.jpg',
  },
  {
    id: 'Saturn',
    name: 'Saturn',
    type: 'Planet',
    constellation: '',
    magnitude: 0.46,
    description:
      "Saturn's ring system spans 270,000 km yet averages only tens of metres thick, one of the most striking sights in a telescope. The rings tilt up to 27 degrees toward Earth over a 15-year cycle, varying from nearly edge-on to fully open. Cloud bands, Cassini's Division, and the moon Titan are visible in apertures above 60 mm. The hexagonal polar vortex is resolved in larger instruments.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Saturn',
    nasaSearchTerm: 'saturn planet cassini',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Saturn.jpg',
  },
  {
    id: 'Uranus',
    name: 'Uranus',
    type: 'Planet',
    constellation: '',
    magnitude: 5.32,
    description:
      "Uranus is an ice giant with a featureless blue-green disk caused by methane absorption in its deep atmosphere. It spans only 3 to 4 arcseconds at opposition, showing no surface detail in most amateur instruments. Its 98-degree axial tilt means it orbits the Sun on its side. The five large moons (Miranda, Ariel, Umbriel, Titania, Oberon) are faintly visible in telescopes above 200 mm.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Uranus',
    nasaSearchTerm: 'uranus planet voyager',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Uranus.jpg',
  },
  {
    id: 'Neptune',
    name: 'Neptune',
    type: 'Planet',
    constellation: '',
    magnitude: 7.78,
    description:
      'Neptune is the most distant major planet, appearing as a tiny blue disk of just 2.4 arcseconds at opposition. Its distinctive color, caused by methane in the atmosphere, distinguishes it from background stars. The large retrograde moon Triton is visible in apertures above 200 mm as a close, faint companion.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Neptune',
    nasaSearchTerm: 'neptune planet voyager',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Planet_Neptune.jpg',
  },

  // ── Dwarf planets ─────────────────────────────────────────────────────────
  {
    id: 'Pluto',
    name: 'Pluto',
    type: 'Dwarf Planet',
    constellation: '',
    magnitude: 14.3,
    description:
      'Pluto orbits the Sun every 248 years and currently sits around magnitude 14.3, requiring a telescope of at least 200 mm to detect as a stellar point. New Horizons revealed heart-shaped nitrogen ice plains, water ice mountains, and a layered nitrogen atmosphere. Pluto can be identified by its slow nightly movement against background stars over several consecutive nights.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Pluto',
    nasaSearchTerm: 'pluto new horizons',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2021/03/Dwarf_Planet_Pluto.jpg',
  },
  {
    id: 'Ceres',
    name: 'Ceres',
    type: 'Dwarf Planet',
    constellation: '',
    magnitude: 6.64,
    description:
      'Ceres is the largest body in the asteroid belt, reaching magnitude 6.6 at opposition and detectable with binoculars under dark skies. Its position shifts noticeably against background stars over days. The Dawn spacecraft revealed bright sodium carbonate deposits in Occator crater and a surface shaped by water ice.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Ceres_(dwarf_planet)',
    nasaSearchTerm: 'ceres dwarf planet dawn',
    astroBackyardUrl: 'https://astrobackyard.com/wp-content/uploads/2024/03/ceres-dwarf-planet.jpg',
  },

  // ── Earth's Moon ──────────────────────────────────────────────────────────
  {
    id: 'Moon',
    name: 'The Moon',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: -12.74,
    description:
      "The Moon orbits Earth at 384,400 km with a diameter of 3,474 km. Its heavily cratered surface, dark maria, mountain ranges, and sinuous rilles are best viewed near the terminator where low-angle lighting brings fine detail into relief. At full Moon the contrast is reduced, but the ray systems radiating from young craters like Tycho are most vivid.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Moon',
    nasaSearchTerm: 'full moon',
    astroBackyardUrl: 'https://images-assets.nasa.gov/image/PIA00405/PIA00405~large.jpg?w=1920&h=1920&fit=clip&crop=faces%2Cfocalpoint',
    aliases: ['luna', 'lunar'],
  },

  // ── Mars moons ────────────────────────────────────────────────────────────
  {
    id: 'Phobos',
    name: 'Phobos',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 11.3,
    description:
      'Phobos is the larger and innermost of the two moons of Mars, orbiting only 6,000 km above the Martian surface and completing three orbits per day. At magnitude 11.3 and extremely close to Mars in the sky, separating it from the planet glare requires excellent seeing and precise timing. Phobos is slowly spiraling inward and will collide with or be torn apart by Mars within 50 million years.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Phobos_(moon)',
    nasaSearchTerm: 'phobos mars moon',
  },
  {
    id: 'Deimos',
    name: 'Deimos',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 12.4,
    description:
      'Deimos is the smaller and outermost moon of Mars, orbiting at 23,460 km with a period of 1.26 days. At magnitude 12.4 it is fainter and only slightly easier to separate from Mars glare than Phobos. Both moons are thought to be captured C-type asteroids similar in composition to carbonaceous chondrite meteorites.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Deimos_(moon)',
    nasaSearchTerm: 'deimos mars moon',
  },

  // ── Jupiter moons ─────────────────────────────────────────────────────────
  {
    id: 'Io',
    name: 'Io',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 5.0,
    description:
      'Io is the innermost Galilean moon and the most volcanically active body in the solar system, continuously resurfaced by sulfur from hundreds of active calderas. Its yellow-orange palette is the result of sulfur and sulfur dioxide deposits. Io can be tracked through its 1.77-day orbit around Jupiter, and it regularly casts a shadow on the cloud tops visible as a small black dot.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Io_(moon)',
    nasaSearchTerm: 'io jupiter moon galileo',
  },
  {
    id: 'Europa',
    name: 'Europa',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 5.3,
    description:
      "Europa has the smoothest surface in the solar system, a water ice shell fractured into a network of brown-red lineae by tidal flexing from Jupiter. The global subsurface ocean beneath the ice is one of the strongest candidates for extraterrestrial life in the solar system. Europa takes 3.55 days to orbit Jupiter and was one of the four moons discovered by Galileo in 1610.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Europa_(moon)',
    nasaSearchTerm: 'europa jupiter moon',
  },
  {
    id: 'Ganymede',
    name: 'Ganymede',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 4.6,
    description:
      'Ganymede is the largest moon in the solar system, exceeding Mercury in diameter. It has two distinct terrain types: dark ancient cratered regions and lighter grooved terrain from later resurfacing. In large apertures it can be resolved as a disk rather than a point. It is the only moon known to have its own intrinsic magnetic field.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Ganymede_(moon)',
    nasaSearchTerm: 'ganymede jupiter moon galileo',
  },
  {
    id: 'Callisto',
    name: 'Callisto',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 5.7,
    description:
      'Callisto is the outermost and most heavily cratered of the Galilean moons, showing no sign of internal geological activity over billions of years. It orbits just beyond Jupiter\'s main radiation belts in a safe zone, completing one orbit every 16.69 days. Unlike the inner Galilean moons, it does not regularly transit across Jupiter\'s disk as seen from Earth.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Callisto_(moon)',
    nasaSearchTerm: 'callisto jupiter moon galileo',
  },
  {
    id: 'Amalthea',
    name: 'Amalthea',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 14.1,
    description:
      "Amalthea is the largest of Jupiter's inner moons, orbiting closer to Jupiter than the Galilean moons in just 12 hours. It is irregularly shaped and deeply reddish from sulfur deposited by nearby Io's volcanoes. At magnitude 14.1 it is a challenging target requiring a large aperture and excellent seeing to separate from Jupiter's glare.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Amalthea_(moon)',
    nasaSearchTerm: 'amalthea jupiter moon voyager',
  },

  // ── Saturn moons ──────────────────────────────────────────────────────────
  {
    id: 'Titan',
    name: 'Titan',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 8.5,
    description:
      "Titan is Saturn's largest moon and the only moon in the solar system with a substantial nitrogen atmosphere. At magnitude 8.5 it is easily visible in small telescopes as an orange-yellow point near Saturn. Its thick haze of hydrocarbon smog creates conditions that support lakes and rivers of liquid methane on the surface, as revealed by the Cassini-Huygens mission.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Titan_(moon)',
    nasaSearchTerm: 'titan saturn moon cassini',
  },
  {
    id: 'Enceladus',
    name: 'Enceladus',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 11.7,
    description:
      "Enceladus is a small, highly reflective moon of Saturn with active geysers at its south pole that eject water vapor and ice particles, feeding Saturn's E ring. At magnitude 11.7 it requires a moderate aperture to detect near Saturn's glare. Cassini confirmed a subsurface liquid water ocean, making it one of the most compelling targets in the search for extraterrestrial life.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Enceladus_(moon)',
    nasaSearchTerm: 'enceladus saturn moon cassini',
  },
  {
    id: 'Rhea',
    name: 'Rhea',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 9.7,
    description:
      "Rhea is Saturn's second-largest moon, a heavily cratered icy world 1,528 km in diameter. It orbits Saturn every 4.5 days and reaches magnitude 9.7, visible in modest telescopes as a point near Saturn. Cassini detected a thin oxygen-carbon dioxide exosphere and faint dusty ring material along its orbit.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Rhea_(moon)',
    nasaSearchTerm: 'rhea saturn moon cassini',
  },
  {
    id: 'Dione',
    name: 'Dione',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 10.4,
    description:
      'Dione is a mid-sized moon of Saturn with a mix of heavily cratered terrain and bright wispy frost streaks formed by tectonic scarps. It orbits Saturn every 2.7 days and reaches magnitude 10.4. The Cassini mission detected traces of oxygen ions in its thin exosphere and found evidence for past geological activity.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Dione_(moon)',
    nasaSearchTerm: 'dione saturn moon cassini',
  },
  {
    id: 'Tethys',
    name: 'Tethys',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 10.2,
    description:
      'Tethys is a moon of Saturn composed almost entirely of water ice, with a density very close to that of water itself. It is home to Odysseus crater, one of the largest impact craters in the solar system relative to its body size, and a vast canyon system called Ithaca Chasma. Tethys reaches magnitude 10.2 and completes an orbit every 1.9 days.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Tethys_(moon)',
    nasaSearchTerm: 'tethys saturn moon cassini',
  },
  {
    id: 'Mimas',
    name: 'Mimas',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 12.9,
    description:
      "Mimas is the smallest and innermost of Saturn's major moons and is dominated by Herschel crater, which spans roughly a third of the moon's diameter. At magnitude 12.9 it is a challenging target even in moderate apertures. Recent analysis of Cassini's gravity data suggests Mimas may conceal a subsurface ocean beneath its icy crust.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Mimas_(moon)',
    nasaSearchTerm: 'mimas saturn moon cassini',
  },
  {
    id: 'Iapetus',
    name: 'Iapetus',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 10.2,
    description:
      "Iapetus has one of the most striking surfaces in the solar system: one hemisphere is pitch black while the other is bright white. This two-tone appearance is caused by thermal segregation of dark organic material swept up from outer moons. Its magnitude varies between about 10 and 12 depending on which hemisphere faces Earth over its 79-day orbit.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Iapetus_(moon)',
    nasaSearchTerm: 'iapetus saturn moon cassini',
  },
  {
    id: 'Hyperion',
    name: 'Hyperion',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 14.1,
    description:
      'Hyperion is an irregularly shaped, sponge-textured moon of Saturn with an unusually low density, suggesting a highly porous interior. It tumbles chaotically in its orbit rather than keeping one face toward Saturn. At magnitude 14.1 it is a difficult target requiring a large aperture and dark skies.',
    wikiUrl: 'https://en.wikipedia.org/wiki/Hyperion_(moon)',
    nasaSearchTerm: 'hyperion saturn moon cassini',
  },

  // ── Uranus moons ──────────────────────────────────────────────────────────
  {
    id: 'Titania',
    name: 'Titania',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 13.9,
    description:
      "Titania is the largest moon of Uranus, with a surface showing both heavily cratered terrain and large fault canyons from past internal activity. It orbits Uranus every 8.7 days and reaches magnitude 13.9. With Oberon it is the easiest of Uranus's moons to observe, requiring a telescope of at least 200 mm and excellent conditions.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Titania_(moon)',
    nasaSearchTerm: 'titania uranus moon voyager',
  },
  {
    id: 'Oberon',
    name: 'Oberon',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 14.1,
    description:
      "Oberon is the outermost large moon of Uranus, with a heavily cratered icy surface and a prominent mountain peak visible in Voyager 2 images. It orbits Uranus every 13.5 days and shines at magnitude 14.1. Both Titania and Oberon are the brightest of Uranus's moons and are the most accessible for amateur observers.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Oberon_(moon)',
    nasaSearchTerm: 'oberon uranus moon voyager',
  },
  {
    id: 'Umbriel',
    name: 'Umbriel',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 14.8,
    description:
      "Umbriel is the darkest of Uranus's major moons, its surface uniformly coated in dark material of uncertain origin. It orbits Uranus every 4.1 days and reaches magnitude 14.8. A bright ring-shaped feature near the north pole, nicknamed the 'fluorescent cheerio,' has not yet been fully explained.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Umbriel_(moon)',
    nasaSearchTerm: 'umbriel uranus moon voyager',
  },
  {
    id: 'Ariel',
    name: 'Ariel',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 14.3,
    description:
      "Ariel has the youngest and brightest surface of Uranus's major moons, crossed by broad intersecting valleys from extensive past geological activity. It orbits Uranus every 2.5 days and reaches magnitude 14.3. Ariel is the third largest of the Uranian moons and shows evidence of relatively recent resurfacing.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Ariel_(moon)',
    nasaSearchTerm: 'ariel uranus moon voyager',
  },
  {
    id: 'Miranda',
    name: 'Miranda',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 15.8,
    description:
      "Miranda is the smallest and innermost of Uranus's five major moons and has one of the most geologically chaotic surfaces in the solar system, with terrain types that seem to have been assembled at random. It is home to Verona Rupes, a cliff face estimated at up to 20 km tall. At magnitude 15.8 it requires a large aperture and tracking mount.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Miranda_(moon)',
    nasaSearchTerm: 'miranda uranus moon voyager',
  },

  // ── Neptune moons ─────────────────────────────────────────────────────────
  {
    id: 'Triton',
    name: 'Triton',
    type: 'Natural Satellite',
    constellation: '',
    magnitude: 13.5,
    description:
      "Triton is Neptune's largest moon and the only large moon in the solar system to orbit in a retrograde direction, strongly suggesting it was captured from the Kuiper Belt rather than forming in place. Voyager 2 imaged active nitrogen geysers erupting from its surface. At magnitude 13.5 it is visible in large apertures but requires careful observation to separate from Neptune's glare.",
    wikiUrl: 'https://en.wikipedia.org/wiki/Triton_(moon)',
    nasaSearchTerm: 'triton neptune moon voyager',
  },
];

// ── Build lookup structures ───────────────────────────────────────────────────

/** Map keyed by UPPERCASE no-space id for getCatalogEntry lookups. */
export const SOLAR_SYSTEM_MAP = new Map<string, CatalogEntry>();

/** Lowercase ids (no spaces) for isSolarSystemObject checks. */
export const SOLAR_SYSTEM_LOOKUP_KEYS = new Set<string>();

/** NASA Image Library search terms keyed by lowercase id. */
export const SOLAR_SYSTEM_NASA_TERMS: Record<string, string> = {};

/** AstroBackyard image URLs keyed by lowercase id (no spaces). */
export const SOLAR_SYSTEM_ASTROBACKYARD_URLS: Record<string, string> = {};

for (const entry of entries) {
  const upperKey = entry.id.toUpperCase().replace(/\s+/g, '');
  const lowerKey = entry.id.toLowerCase().replace(/\s+/g, '');
  SOLAR_SYSTEM_MAP.set(upperKey, entry);
  SOLAR_SYSTEM_LOOKUP_KEYS.add(lowerKey);
  SOLAR_SYSTEM_NASA_TERMS[lowerKey] = entry.nasaSearchTerm;
  if (entry.astroBackyardUrl) SOLAR_SYSTEM_ASTROBACKYARD_URLS[lowerKey] = entry.astroBackyardUrl;

  for (const alias of entry.aliases ?? []) {
    const aliasUpper = alias.toUpperCase().replace(/\s+/g, '');
    const aliasLower = alias.toLowerCase().replace(/\s+/g, '');
    // Alias entries return a copy of the entry with the alias as id so that
    // the objectId stored in the DB matches what the user typed as the folder name.
    SOLAR_SYSTEM_MAP.set(aliasUpper, { ...entry, id: alias });
    SOLAR_SYSTEM_LOOKUP_KEYS.add(aliasLower);
    SOLAR_SYSTEM_NASA_TERMS[aliasLower] = entry.nasaSearchTerm;
    if (entry.astroBackyardUrl) SOLAR_SYSTEM_ASTROBACKYARD_URLS[aliasLower] = entry.astroBackyardUrl;
  }
}

/** All canonical solar system entries (no alias duplicates). Used for prefetch iteration. */
export const SOLAR_SYSTEM_CATALOG: readonly SolarEntry[] = entries;
