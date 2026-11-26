/**
 * "What's in my image?": a short list of objects worth pointing out in a picture although the catalog leaves them
 * out, because they are faint, point-like or not deep-sky objects at all: the first quasar, the first black hole
 * found, gravitational lenses, jets aimed at us. Each gets a card on the client (text in its locale files, keyed by
 * the id below), so a faint dot in a picture of Virgo becomes "this is a quasar whose light left it 2.4 billion
 * years ago".
 *
 * Positions are J2000 from SIMBAD (read through its CfA mirror in November 2026). They are only drawn on an exact
 * solution (a plate solve or the header's WCS): these are points, and an approximate field could put the mark on the
 * wrong star.
 */
import { angularSeparationDeg, pixelScaleArcsec, pixelToSky, skyToPixel, type Wcs } from './wcs.js';
import type { FrameAnnotation } from './catalogQuery.js';

export type NotableKind = 'quasar' | 'blackHole' | 'lens' | 'blazar' | 'microquasar';

export interface NotableObject {
  /** Stable id; the client's card text is under `annotate.notable.about.<id>`. */
  id: string;
  /** The name drawn beside the mark, the same in every language. */
  label: string;
  /** A catalog designation shown after the name, or null when the name already is one. */
  designation: string | null;
  kind: NotableKind;
  raDeg: number;
  decDeg: number;
}

export const NOTABLE_OBJECTS: readonly NotableObject[] = [
  { id: '3c273', label: '3C 273', designation: null, kind: 'quasar', raDeg: 187.27791594049, decDeg: 2.05238823055 },
  { id: 'cygx1', label: 'Cygnus X-1', designation: 'HD 226868', kind: 'blackHole', raDeg: 299.59031556498, decDeg: 35.20160680908 },
  { id: 'm87star', label: 'M87*', designation: null, kind: 'blackHole', raDeg: 187.70593076725, decDeg: 12.391123246083334 },
  { id: 'sgrastar', label: 'Sgr A*', designation: null, kind: 'blackHole', raDeg: 266.41681662499997, decDeg: -29.00782497222222 },
  { id: 'twinquasar', label: 'Twin Quasar', designation: 'QSO B0957+561', kind: 'lens', raDeg: 150.33621623072, decDeg: 55.89877609702 },
  { id: 'einsteincross', label: 'Einstein Cross', designation: 'QSO B2237+0305', kind: 'lens', raDeg: 340.125975, decDeg: 3.3585083333333334 },
  { id: 'mrk421', label: 'Mrk 421', designation: null, kind: 'blazar', raDeg: 166.11380868146, decDeg: 38.20883291552 },
  { id: 'mrk501', label: 'Mrk 501', designation: null, kind: 'blazar', raDeg: 253.46756951679168, decDeg: 39.76016913205556 },
  { id: 'bllac', label: 'BL Lacertae', designation: 'BL Lac', kind: 'blazar', raDeg: 330.68038064033993, decDeg: 42.27777206022 },
  { id: 'oj287', label: 'OJ 287', designation: null, kind: 'blazar', raDeg: 133.70364576928, decDeg: 20.10851099545 },
  { id: 'ss433', label: 'SS 433', designation: null, kind: 'microquasar', raDeg: 287.95651987395, decDeg: 4.982729757679999 },
];

/** A point mark's ring, as a share of the picture's long side: the smallest ring the catalog layer draws. */
const POINT_RING_FRACTION = 0.012;

/** The notable objects inside the picture, as rings of the `notable` layer. */
export function notableInFrame(wcs: Wcs): FrameAnnotation[] {
  const { width, height } = wcs;
  const arcsecPerPx = pixelScaleArcsec(wcs);
  if (!(arcsecPerPx > 0)) return [];
  const centre = pixelToSky(wcs, width / 2, height / 2);
  const halfDiagDeg = (Math.hypot(width, height) / 2) * arcsecPerPx / 3600;
  const r = Math.max(width, height) * POINT_RING_FRACTION;

  const found: FrameAnnotation[] = [];
  for (const o of NOTABLE_OBJECTS) {
    if (angularSeparationDeg(centre.raDeg, centre.decDeg, o.raDeg, o.decDeg) > halfDiagDeg) continue;
    const p = skyToPixel(wcs, o.raDeg, o.decDeg);
    if (!p || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    found.push({
      id: `notable:${o.id}`,
      label: o.label,
      designation: o.designation,
      typeCode: o.kind,
      type: o.kind,
      magnitude: null,
      x: p.x,
      y: p.y,
      r,
      rTrue: r,
      oversized: false,
      isTarget: false,
      layer: 'notable',
    });
  }
  return found;
}
