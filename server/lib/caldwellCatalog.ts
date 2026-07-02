/**
 * Caldwell catalog: maps Caldwell C-numbers to their NGC/IC catalog IDs.
 *
 * Source: NASA Hubble Caldwell Catalog pages (science.nasa.gov) plus
 * standard reference data for objects not covered by the Hubble program.
 *
 * Objects already stored in OpenNGC under their C-number (C9, C41) are
 * excluded from this map — the standard catalog lookup handles them.
 *
 * Objects with no NGC/IC designation (C99 Coalsack) map to their C-id so
 * the OpenNGC lookup falls through to the C{n} entry if present.
 */

/** Maps Caldwell number (1–109) → primary catalog ID string, e.g. "NGC4449". */
export const CALDWELL_TO_NGC: Record<number, string> = {
  1:  'NGC188',
  2:  'NGC40',
  3:  'NGC4236',
  4:  'NGC7023',
  5:  'IC342',
  6:  'NGC6543',
  7:  'NGC2403',
  8:  'NGC559',
  // C9  = Sh2-155 (Cave Nebula) — already in OpenNGC as "C9"
  10: 'NGC663',
  11: 'NGC7635',
  12: 'NGC6946',
  13: 'NGC457',
  14: 'NGC869',
  15: 'NGC6826',
  16: 'NGC7243',
  17: 'NGC147',
  18: 'NGC185',
  19: 'IC5146',
  20: 'NGC7000',
  21: 'NGC4449',   // dwarf irregular starburst galaxy, Canes Venatici
  22: 'NGC7662',
  23: 'NGC891',    // edge-on spiral galaxy, Andromeda
  24: 'NGC1275',
  25: 'NGC2419',
  26: 'NGC4244',
  27: 'NGC6888',
  28: 'NGC752',
  29: 'NGC5005',
  30: 'NGC7331',
  31: 'IC405',
  32: 'NGC4631',
  33: 'NGC6992',
  34: 'NGC6960',
  35: 'NGC4889',
  36: 'NGC4559',
  37: 'NGC6885',
  38: 'NGC4565',
  39: 'NGC2392',
  40: 'NGC3626',
  // C41 = Hyades — already in OpenNGC as "C41"
  42: 'NGC7006',
  43: 'NGC7814',
  44: 'NGC7479',
  45: 'NGC5248',
  46: 'NGC2261',
  47: 'NGC6934',
  48: 'NGC2775',
  49: 'NGC2237',
  50: 'NGC2244',
  51: 'IC1613',
  52: 'NGC4697',
  53: 'NGC3115',
  54: 'NGC2506',
  55: 'NGC7009',
  56: 'NGC246',
  57: 'NGC6822',
  58: 'NGC2360',
  59: 'NGC3242',
  60: 'NGC4038',
  61: 'NGC4039',
  62: 'NGC247',
  63: 'NGC7293',
  64: 'NGC2362',
  65: 'NGC253',
  66: 'NGC5694',
  67: 'NGC1097',
  68: 'NGC6729',
  69: 'NGC6302',
  70: 'NGC300',
  71: 'NGC2477',
  72: 'NGC55',
  73: 'NGC1851',
  74: 'NGC3132',
  75: 'NGC6124',
  76: 'NGC6231',
  77: 'NGC5128',
  78: 'NGC6541',
  79: 'NGC3201',
  80: 'NGC5139',
  81: 'NGC6352',
  82: 'NGC6193',
  83: 'NGC4945',
  84: 'NGC5286',
  85: 'IC2391',
  86: 'NGC6397',
  87: 'NGC1261',
  88: 'NGC5823',
  89: 'NGC6087',
  90: 'NGC2867',
  91: 'NGC3532',
  92: 'NGC3372',
  93: 'NGC6752',
  94: 'NGC4755',
  95: 'NGC6025',
  96: 'NGC2516',
  97: 'NGC3766',
  98: 'NGC4609',
  // C99 = Coalsack (dark nebula, no NGC) — OpenNGC won't have it; Sesame handles it
  100: 'IC2944',
  101: 'NGC6744',
  102: 'NGC2070',
  103: 'NGC2547',
  104: 'NGC362',
  105: 'NGC4833',
  106: 'NGC104',
  107: 'NGC6101',
  108: 'NGC4372',
  109: 'NGC3195',
};

/**
 * Coordinates for Caldwell objects that have no NGC/IC designation and therefore
 * no entry in the DSO catalog. Used as a fallback when the image route needs
 * RA/Dec to query DSS2 for an on-demand sky plate.
 *
 * ra is in hours (× 15 → degrees), dec is in degrees.
 * majorAxisArcmin gives the approximate angular extent for FOV selection.
 */
export const CALDWELL_FALLBACK_COORDS: Record<number, { ra: number; dec: number; majorAxisArcmin: number }> = {
  // C99 = Coalsack dark nebula — ~7° across, no NGC designation.
  // RA 12h 52m, Dec -63° 18'.  DSS2 at 3° FOV (capped max) shows the dark patch well.
  99: { ra: 12.873, dec: -63.3, majorAxisArcmin: 420 },
};

/**
 * Given an ID like "C21", return the canonical NGC/IC id ("NGC4449"), or null
 * if this isn't a recognized Caldwell designation.
 */
export function caldwellToNgcId(id: string): string | null {
  const m = id.match(/^C(\d{1,3})$/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return CALDWELL_TO_NGC[num] ?? null;
}

/**
 * Reverse lookup: given a canonical NGC/IC id, return its Caldwell number
 * (1–109), or null if the object is not in the Caldwell catalog.
 */
export function ngcToCaldwell(ngcId: string): number | null {
  const upper = ngcId.toUpperCase();
  for (const [num, id] of Object.entries(CALDWELL_TO_NGC)) {
    if (id === upper) return parseInt(num, 10);
  }
  return null;
}
