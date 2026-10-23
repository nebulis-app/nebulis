/**
 * True when an object id reads as a comet designation. Comets are not in the
 * deep-sky catalogs, so this folder-name shape is the only signal.
 *
 *   periodic   "161PHartley-IRAS", "10P Tempel", "220P_McNaught", bare "1P"
 *   provisional "C/2023 A3", "C-2023 A3", "P/2010 H2", "C2023A3"
 *
 * Whole-string and strict on purpose: "3C273", "NGC7000", "M31_mosaic" and
 * Caldwell "C14" must never match. C/D periodic forms require a trailing name
 * so a bare "12C" is not claimed.
 */
export function looksLikeComet(objectId: string): boolean {
  const id = objectId.trim();
  if (/^\d{1,4}P(?:[\s_/-]*[A-Za-z][A-Za-z'-]*.*)?$/i.test(id)) return true;
  if (/^\d{1,4}[CD][\s_/-]*[A-Za-z][A-Za-z'-]+/i.test(id)) return true;
  return /^[CPDXI][\s/_-]?\d{4}[\s_]?[A-Z]{1,2}\d*/i.test(id) && !/^C\d{1,3}$/i.test(id);
}

/** Types whose position changes night to night. No fixed RA/Dec means no sky survey picture can be right for them. */
const MOVING_OBJECT_TYPES = new Set(['Comet', 'Asteroid']);

/**
 * True for a comet or asteroid. Their only picture is one of their own observations: the catalog and the sky survey
 * have nothing for them, so asking either is wasted work. The id shape catches a comet before its type is stored.
 */
export function isMovingObject(objectId: string, objectType?: string | null): boolean {
  return (objectType != null && MOVING_OBJECT_TYPES.has(objectType)) || looksLikeComet(objectId);
}

/**
 * One spelling for a comet, so folders named differently by different telescopes meet in one card:
 *
 *   provisional  "C-2023A3", "C2023A3(Tsuchinshan-ATLAS)", "C/2023 A3"  → "C/2023 A3"
 *                "C2025R3PANSTARRS"                                     → "C/2025 R3"
 *   periodic     "161P", "161PHartley-IRAS", "12P_Pons-Brooks"          → "161P", "12P"
 *                "73P-B" (a fragment is its own object)                 → "73P-B"
 *
 * The name after a designation is decoration and is ignored. Returns null for anything that is not a comet
 * designation, including a name with no designation ("CometLemmon"), which this cannot place.
 */
export function cometKey(objectId: string): string | null {
  const id = objectId.trim();

  // Half-month letter (never I, never Z), an optional second letter once a half-month passes 25 comets, then the
  // order number. The number is always there, which is what separates "A3PANSTARRS" from a name that starts "ATLAS".
  const provisional = id.match(/^([CPDXI])[\s/_-]*(\d{4})[\s_-]*([A-HJ-Y][A-Z]?)(\d+)/i);
  if (provisional && !/^C\d{1,3}$/i.test(id)) {
    const [, prefix, year, letters, order] = provisional;
    return `${prefix.toUpperCase()}/${year} ${letters.toUpperCase()}${order}`;
  }

  // After the number and letter comes nothing, a separator and a name, or (for P only) a name glued on in capitals.
  // A glued lowercase tail is a star ("51Peg", "61Cygni"), which must never fold into a comet.
  const periodic = id.match(/^(\d{1,4})([PCD])(?:([\s_/-]+)([A-Za-z][A-Za-z'-]*.*)|([A-Z][A-Za-z'-]*.*))?$/i);
  if (periodic) {
    const [, number, letter, separator, spaced, glued] = periodic;
    const isP = letter.toUpperCase() === 'P';
    const rest = spaced ?? glued;
    if (rest === undefined && !isP) return null; // a bare "12C" is not claimed
    if (glued !== undefined && !(isP && letter === 'P' && /^[A-Z]/.test(glued))) return null;
    if (separator === undefined && glued === undefined && rest !== undefined) return null;
    const base = `${Number(number)}${letter.toUpperCase()}`;
    return rest && /^[A-Z]{1,2}$/i.test(rest) ? `${base}-${rest.toUpperCase()}` : base;
  }
  return null;
}
