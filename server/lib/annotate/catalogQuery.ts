/**
 * Which catalog objects fall inside a solved frame, and where they land.
 *
 * Source is the Planner catalog (OpenNGC + the curated extras, ~4,400 deep-sky
 * objects) rather than a star catalog: this feature labels things a person
 * would want named on a deep-sky photo, not every field star.
 *
 * The raw hit list for a typical frame is dominated by faint, tiny galaxies
 * nobody can see in a short stack, so the result is ranked and capped. Ranking
 * favours what a viewer recognises (Messier, a common name, bright, large) and
 * the frame's own target is always kept.
 */
import { getCatalog, getPlannerCatalog, type DsoEntry } from '../dsoCatalog.js';
import { resolveCanonicalId } from '../catalogAliases.js';
import { angularSeparationDeg, pixelScaleArcsec, pixelToSky, skyToPixel, type Wcs } from './wcs.js';

export interface FrameAnnotation {
  id: string;
  /** What to print: the common name when there is one, otherwise the designation. */
  label: string;
  /** Designation shown under a common name ("M42"), or null when `label` already is it. */
  designation: string | null;
  typeCode: string;
  type: string;
  magnitude: number | null;
  /** Centre, in pixels of the image the solution describes (top-left origin). */
  x: number;
  y: number;
  /** Draw radius in pixels: the object's true angular radius, floored so a
   *  small object is still a visible ring and capped so a huge one still fits. */
  r: number;
  /** True angular radius in pixels, unclamped. Lets a client tell "really that
   *  big" from "clamped to be visible". */
  rTrue: number;
  /** The object's true size is bigger than a ring may be on this frame, so the
   *  ring marks the region rather than outlining the object. */
  oversized: boolean;
  isTarget: boolean;
}

export interface AnnotateOptions {
  /** Canonical id of the frame's own object. Always included when in frame. */
  targetId?: string | null;
  /** Hard cap on returned annotations. */
  limit?: number;
  /** Faintest magnitude worth labelling. */
  limitMagnitude?: number;
}

const DEFAULT_LIMIT = 24;
const DEFAULT_LIMIT_MAG = 14.5;
/** Smallest ring, as a fraction of the image's long side. */
const MIN_RADIUS_FRACTION = 0.012;
/** Largest ring, as a fraction of the image's short side. A big nebula (M42's
 *  catalog size is 90') would otherwise get a ring wider than the frame, which
 *  marks nothing. `rTrue` keeps the real size. */
const MAX_RADIUS_FRACTION = 0.42;
/** A catalog object with no magnitude is only worth a ring if it is this big. */
const UNRATED_MIN_ARCMIN = 3;

const norm = (id: string): string => resolveCanonicalId(id).toUpperCase().replace(/\s+/g, '');

function importance(e: DsoEntry, isTarget: boolean): number {
  if (isTarget) return 1000;
  let score = 0;
  if (e.messier != null) score += 40;
  if (e.name && e.name !== e.id) score += 15;
  score += e.magnitude != null ? Math.max(0, 18 - e.magnitude) : 4;
  if (e.majorAxisArcmin) score += Math.min(12, Math.log2(1 + e.majorAxisArcmin) * 2.5);
  return score;
}

/** Every designation an entry answers to: its own id plus any other NGC / IC /
 *  Messier / Caldwell number listed among its names. OpenNGC records a
 *  double-numbered object this way (its NGC 2239 lists NGC 2244). */
const DESIGNATION_NAME = /^(NGC|IC|M|C)\s?\d+$/i;
function identities(e: DsoEntry): Set<string> {
  const ids = new Set([norm(e.id)]);
  for (const n of e.commonNames) if (DESIGNATION_NAME.test(n.trim())) ids.add(norm(n));
  return ids;
}

interface Hit { entry: DsoEntry; ann: FrameAnnotation; score: number }

/**
 * The catalog can hold one object twice: a curated record and an OpenNGC row
 * for the same thing under two NGC numbers (the Rosette Cluster is NGC 2244 in
 * one and NGC 2239 in the other, at positions several arcminutes apart). Drawn
 * separately that is two rings, one of them visibly off the object.
 *
 * Duplicates are merged into one ring that keeps the better-known name and id
 * but sits where OpenNGC puts the object. OpenNGC is the survey-derived source
 * the rest of the catalog's positions come from; the curated rows are
 * hand-entered and can carry an older or rounder position.
 */
function mergeDuplicates(hits: Hit[]): Hit[] {
  const base = new Set(getCatalog().map(e => e.id));
  const ids = hits.map(h => identities(h.entry));
  const gone = new Set<number>();
  const out: Hit[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (gone.has(i)) continue;
    let keep = hits[i];
    for (let j = i + 1; j < hits.length; j++) {
      if (gone.has(j) || ![...ids[j]].some(x => ids[i].has(x))) continue;
      gone.add(j);
      const other = hits[j];
      const named = keep.entry.name !== keep.entry.id || other.entry.name === other.entry.id ? keep : other;
      const located = base.has(keep.entry.id) || !base.has(other.entry.id) ? keep : other;
      keep = {
        entry: named.entry,
        score: Math.max(keep.score, other.score),
        ann: {
          ...named.ann,
          x: located.ann.x,
          y: located.ann.y,
          r: located.ann.r,
          rTrue: located.ann.rTrue,
          oversized: located.ann.oversized,
          isTarget: keep.ann.isTarget || other.ann.isTarget,
        },
      };
    }
    out.push(keep);
  }
  return out;
}

/**
 * Two rings can legitimately carry one name: OpenNGC calls both M 16 and its
 * core IC 4703 "Eagle Nebula", and the Rosette has the same pattern. Two
 * identical labels cannot be told apart on the picture, so the better-ranked
 * ring (the list is already in rank order) keeps the name and the other shows
 * only its designation. Its details card still carries the full name.
 */
function distinctLabels(items: FrameAnnotation[]): FrameAnnotation[] {
  const seen = new Set<string>();
  return items.map(a => {
    const key = a.label.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      return a;
    }
    return { ...a, label: a.id, designation: null };
  });
}

export function annotateFrame(wcs: Wcs, opts: AnnotateOptions = {}): FrameAnnotation[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const limitMag = opts.limitMagnitude ?? DEFAULT_LIMIT_MAG;
  const targetKey = opts.targetId ? norm(opts.targetId) : null;

  const { width, height } = wcs;
  const arcsecPerPx = pixelScaleArcsec(wcs);
  if (!(arcsecPerPx > 0)) return [];
  const longSide = Math.max(width, height);
  const minR = longSide * MIN_RADIUS_FRACTION;
  const maxR = Math.min(width, height) * MAX_RADIUS_FRACTION;

  // Cheap pre-filter on the sky before projecting anything: nothing farther
  // from the centre than the frame's half-diagonal (plus the biggest object
  // we'd still draw) can be inside it.
  const centre = pixelToSky(wcs, width / 2, height / 2);
  const halfDiagDeg = (Math.hypot(width, height) / 2) * arcsecPerPx / 3600;

  const found: Hit[] = [];

  for (const e of getPlannerCatalog()) {
    const raDeg = e.ra * 15;
    const radiusDeg = ((e.majorAxisArcmin ?? 0) / 2) / 60;
    if (angularSeparationDeg(centre.raDeg, centre.decDeg, raDeg, e.dec) > halfDiagDeg + radiusDeg) continue;

    const isTarget = targetKey != null && norm(e.id) === targetKey;
    if (!isTarget) {
      if (e.magnitude != null ? e.magnitude > limitMag : (e.majorAxisArcmin ?? 0) < UNRATED_MIN_ARCMIN) continue;
    }

    const p = skyToPixel(wcs, raDeg, e.dec);
    if (!p) continue;
    const rTrue = ((e.majorAxisArcmin ?? 0) * 60 / 2) / arcsecPerPx;
    const r = Math.min(Math.max(rTrue, minR), maxR);
    // The centre has to be on the picture (a ring around something half off
    // the edge is fine, but a ring whose centre is off-frame reads as a bug).
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;

    found.push({
      entry: e,
      score: importance(e, isTarget),
      ann: {
        id: e.id,
        label: e.name && e.name !== e.id ? e.name : e.id,
        designation: e.name && e.name !== e.id ? e.id : null,
        typeCode: e.typeCode,
        type: e.type,
        magnitude: e.magnitude,
        x: p.x,
        y: p.y,
        r,
        rTrue,
        oversized: rTrue > maxR,
        isTarget,
      },
    });
  }

  const hits = mergeDuplicates(found);
  hits.sort((a, b) => b.score - a.score);

  // Greedy keep, dropping a hit sitting on top of a better one. Catalogs list
  // the same thing twice (an NGC knot inside a bigger nebula, a cluster and its
  // embedded nebula), and two labels on one spot are just noise.
  const kept: FrameAnnotation[] = [];
  for (const h of hits) {
    if (kept.length >= limit) break;
    const a = h.ann;
    const stacked = kept.some(k => Math.hypot(k.x - a.x, k.y - a.y) < Math.min(k.r, a.r) * 0.6);
    if (stacked && !a.isTarget) continue;
    kept.push(a);
  }
  return distinctLabels(kept);
}
