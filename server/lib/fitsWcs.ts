/**
 * FITS header helpers for sky coordinates and WCS.
 *
 * Extracted from routes/satellite.ts so the parsing rules — which are where
 * cross-telescope compatibility actually lives — can be tested directly
 * against the header spellings different capture software emits.
 */

/**
 * Split a sexagesimal string into its three components, whatever separators
 * the writer used.
 *
 * The FITS convention for OBJCTRA/OBJCTDEC is a quoted string of three
 * space-separated numbers ('18 18 48.00'). MaxIm DL, TheSkyX, APT, SGP and
 * some ASIAIR firmware write exactly that; others use colons, and a few use
 * h/m/s or d/m/s or °/′/″ letters. Only the h/m/s spelling used to be
 * recognised, so '18 18 48.00' fell through to `parseFloat`, which stops at
 * the first space and returns **18** — read as 18 degrees instead of 274.7,
 * a 256° error that rejected every satellite as too far from the frame. The
 * DEC equivalent lost the arcminutes, an error of up to ~1°, larger than most
 * fields on its own.
 *
 * Returns null when the value is a plain decimal (or unparseable), so the
 * caller can fall back to reading it as degrees.
 */
function parseSexagesimal(raw: string): { sign: number; a: number; b: number; c: number } | null {
  const text = raw.trim();
  // Reject a bare decimal early: '274.700' must not be read as 274h 7m.
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const parts = text.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!parts || parts.length < 2) return null;
  const sign = /^\s*-/.test(text) ? -1 : 1;
  const a = Math.abs(parseFloat(parts[0]));
  const b = Math.abs(parseFloat(parts[1]));
  const c = parts.length > 2 ? Math.abs(parseFloat(parts[2])) : 0;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return { sign, a, b, c };
}

export function parseRaToDegs(ra: string): number {
  const sx = parseSexagesimal(ra);
  if (sx) {
    // RA sexagesimal is always in HOURS, so 15°/hour.
    const hours = sx.a + sx.b / 60 + sx.c / 3600;
    const degrees = hours * 15;
    // A leading '-' on an RA is meaningless but harmless; normalize to [0,360).
    return ((sx.sign * degrees) % 360 + 360) % 360;
  }
  const num = parseFloat(ra);
  return isNaN(num) ? 0 : num;
}

export function parseDecToDegs(dec: string): number {
  const sx = parseSexagesimal(dec);
  if (sx) {
    return sx.sign * (sx.a + sx.b / 60 + sx.c / 3600);
  }
  const num = parseFloat(dec);
  return isNaN(num) ? 0 : num;
}

/**
 * Read a FITS header value that should be numeric.
 *
 * `parseFitsHeader` returns a `string` for any QUOTED card, and firmware does
 * quote numbers: `EXPTIME= '10.0'` is legal-ish and appears in the wild. A
 * bare `typeof v === 'number'` check therefore reported EXPTIME as a missing
 * header (skipping identification entirely) and silently replaced a quoted
 * FOCALLEN/XPIXSZ with the per-kind default, changing the computed FOV.
 */
export function headerNumber(v: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = v[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = parseFloat(raw.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * A FITS WCS CD matrix: degrees of sky per pixel step, as a 2×2.
 * Row 1 is east (RA·cos δ), row 2 is north (DEC).
 *
 * It carries three things this route needs and cannot get anywhere else:
 * the trail's sky position angle (so the motion-direction filter compares two
 * angles in the same frame rather than an image angle against a sky one), the
 * sensor's rotation (so the FOV rectangle is oriented to the pixels), and the
 * true plate scale (which needs no assumption about focal length or binning).
 */
export interface CdMatrix {
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
}

/**
 * Recover a CD matrix from the header, in either WCS spelling.
 *
 * Two gaps this closes:
 *
 *  - `CDi_j` elements that are zero may be omitted; the WCS standard says an
 *    absent element defaults to 0 once any CD card is present. Requiring all
 *    four meant a perfectly good unrotated solution (only CD1_1 and CD2_2
 *    written, the common case) was treated as "no WCS".
 *  - The older `CDELT1/CDELT2 + CROTA2` convention was not read at all, so
 *    every frame using it — much INDI/EKOS output, and SeeStar — silently
 *    lost both the trail-angle filter and the sensor rotation.
 */
export function readCdMatrix(v: Record<string, unknown>): CdMatrix | null {
  const cd11 = headerNumber(v, 'CD1_1');
  const cd12 = headerNumber(v, 'CD1_2');
  const cd21 = headerNumber(v, 'CD2_1');
  const cd22 = headerNumber(v, 'CD2_2');
  if (cd11 !== undefined || cd12 !== undefined || cd21 !== undefined || cd22 !== undefined) {
    // At least one CD card present: absent siblings are 0 by definition. A
    // matrix with no scale on either axis is degenerate, not unrotated.
    const m = { cd11: cd11 ?? 0, cd12: cd12 ?? 0, cd21: cd21 ?? 0, cd22: cd22 ?? 0 };
    const det = m.cd11 * m.cd22 - m.cd12 * m.cd21;
    return det === 0 ? null : m;
  }

  // CDELT + CROTA2 fallback. CROTA2 rotates the sky axes onto the pixel axes:
  //   CD1_1 =  CDELT1·cos ρ   CD1_2 = -CDELT2·sin ρ
  //   CD2_1 =  CDELT1·sin ρ   CD2_2 =  CDELT2·cos ρ
  const cdelt1 = headerNumber(v, 'CDELT1');
  const cdelt2 = headerNumber(v, 'CDELT2');
  if (cdelt1 === undefined || cdelt2 === undefined || cdelt1 === 0 || cdelt2 === 0) return null;
  const rho = (headerNumber(v, 'CROTA2', 'CROTA1') ?? 0) * Math.PI / 180;
  const cos = Math.cos(rho), sin = Math.sin(rho);
  return {
    cd11: cdelt1 * cos,
    cd12: -cdelt2 * sin,
    cd21: cdelt1 * sin,
    cd22: cdelt2 * cos,
  };
}

/**
 * Convert a trail angle in image-pixel coordinates into a sky position angle
 * in degrees east of north. Returns null when the header carries no usable
 * WCS — the caller then skips the motion-direction filter rather than
 * comparing two angles that don't share a frame.
 */
export function imageAngleToSkyPA(imageAngleDeg: number, cd: CdMatrix): number {
  const theta = imageAngleDeg * Math.PI / 180;
  // trailDetector now reports the trail's own direction (it used to report the
  // perpendicular), so the pixel-space direction vector is (cos θ, sin θ).
  const lineX = Math.cos(theta);
  const lineY = Math.sin(theta);
  // Apply CD matrix (degrees-per-pixel): pixel deltas → sky deltas.
  // Row 1 is east (RA·cos δ), row 2 is north (DEC).
  const dEast = cd.cd11 * lineX + cd.cd12 * lineY;
  const dNorth = cd.cd21 * lineX + cd.cd22 * lineY;
  const skyPA = Math.atan2(dEast, dNorth) * 180 / Math.PI;
  return ((skyPA % 360) + 360) % 360;
}

/**
 * Sky position angle (east of north) of the sensor's +x axis, from the CD
 * matrix: a one-pixel step along +x moves CD1_1 east and CD2_1 north.
 * satelliteTracker uses this to orient the FOV rectangle instead of assuming
 * the sensor is square to RA/DEC.
 */
export function sensorRotationFromCd(cd: CdMatrix): number {
  const pa = Math.atan2(cd.cd11, cd.cd21) * 180 / Math.PI;
  return ((pa % 360) + 360) % 360;
}
