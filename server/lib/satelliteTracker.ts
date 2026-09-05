import * as satellite from 'satellite.js';
import { satelliteCatalog, type TLERecord } from './satelliteCatalog.js';
import { assertNever, isRecord } from './typeGuards.js';

export interface ObservationParams {
  timestamp: string;        // ISO date
  exposureSeconds: number;
  observerLat: number;      // degrees
  observerLon: number;      // degrees
  imageCenterRA: number;    // degrees
  imageCenterDEC: number;   // degrees
  fovWidthDeg: number;
  fovHeightDeg: number;
  detectedTrailAngle?: number; // degrees, optional
  /**
   * Sky position angle (degrees east of north) of the sensor's +x axis — the
   * NAXIS1 direction. Derived from the FITS CD matrix by the caller.
   *
   * Defaults to 90 (i.e. +x points east), which is what the FOV test assumed
   * unconditionally before this existed: `fovWidthDeg` was compared against
   * the RA offset and `fovHeightDeg` against the DEC offset. That is only true
   * for an unrotated camera; every rotator, every manually-clocked camera and
   * every alt-az field-rotation offset tests a rectangle turned off the frame's
   * real footprint, and the error grows with the sensor's aspect ratio.
   */
  fovRotationDeg?: number;
}

/** Default sensor rotation: +x axis points east, matching the pre-rotation
 *  behaviour of satelliteCrossesFOV. */
export const DEFAULT_FOV_ROTATION_DEG = 90;

/**
 * Fastest topocentric angular rate we budget for, in degrees per second. A
 * very low LEO pass near zenith reaches ~1.2°/s; 1.5 leaves headroom so the
 * coarse scan below can never step over a satellite it should have caught.
 */
const MAX_RATE_DEG_PER_SEC = 1.5;

/** Coarse scan budget: propagations per satellite used to decide whether a
 *  record comes anywhere near the frame during the exposure. Bounded so a
 *  600 s sub costs the same as a 10 s one. */
const COARSE_MAX_SAMPLES = 24;

/** Bounds on the fine sampling step, in seconds. The upper bound is the old
 *  fixed step; the lower bound keeps a narrow-field rig from asking for tens
 *  of thousands of propagations. */
const FINE_STEP_MIN_SEC = 0.01;
const FINE_STEP_MAX_SEC = 0.2;

/** Maximum fine samples per satellite, so an adaptive step can never blow up
 *  the per-frame cost. */
const FINE_MAX_SAMPLES = 400;

/**
 * Track points carried through the pipeline: the public {ra, dec, time} plus
 * the two things the internals need and callers must not see — the offset in
 * seconds from the window start (`t`, used for rate estimation without
 * re-parsing ISO strings) and the ECI position (reused for the horizon and
 * illumination tests instead of propagating a second time).
 */
interface TrackPoint {
  ra: number;
  dec: number;
  time: string;
  t: number;
  eci: satellite.EciVec3<number>;
}

/** Strip the internal fields before a track leaves the tracker. */
function toPublicTrack(track: TrackPoint[]): SatelliteCandidate['track'] {
  return track.map(({ ra, dec, time }) => ({ ra, dec, time }));
}

/** Frame geometry and scan cadence, computed once per image rather than once
 *  per TLE record. */
interface SearchWindow {
  /** Seconds between coarse scan samples across the exposure window. */
  coarseStepSec: number;
  /** A coarse sample this far from the frame centre still warrants fine
   *  sampling: the frame's half-diagonal plus one coarse step of travel. */
  preFilterRadius: number;
  fovHalfDiag: number;
  /** Sky position angle of the sensor's +x axis, degrees east of north. */
  fovRotationDeg: number;
  /** Shorter FOV dimension in degrees — sets how fine the sampling must be for
   *  a transit not to fall between two samples. */
  minFovDeg: number;
}

export interface SatelliteCandidate {
  satellite: string;
  noradId: number;
  crossingTimeUTC: string;
  angularDistanceFromCenter: number;
  velocityDegPerSec: number;
  matchScore: number;
  track: Array<{ ra: number; dec: number; time: string }>;
}

// Every reason evaluateSatellite() can reject a record. A stringly-typed
// `reason?: string` can't be exhaustiveness-checked, which is how 'propagation'
// once fell through filterVisibleSatellites' switch without being counted. Keep
// this closed: RejectionTally below derives its keys from it.
export type EvalReason = 'horizon' | 'distance' | 'period' | 'fov' | 'angle' | 'shadow' | 'slow' | 'propagation';

/**
 * Per-reason tally of the records the pipeline discarded. Diagnostic: callers
 * act on candidates/nearMisses, but the counts are what explain an empty
 * result ("every pass was below the horizon" vs "no TLE would propagate").
 *
 * `Record<EvalReason, number>` *is* the exhaustiveness check here, and a
 * stronger one than the switch it replaces: add a reason to the union and the
 * zeroed initializer below stops compiling, so a new reason can never be
 * counted into nothing. The eight separate `let` counters this replaces were
 * incremented and then never read by anyone.
 */
export type RejectionTally = Record<EvalReason, number>;

function emptyRejectionTally(): RejectionTally {
  return {
    horizon: 0,
    distance: 0,
    period: 0,
    fov: 0,
    angle: 0,
    shadow: 0,
    slow: 0,
    propagation: 0,
  };
}

/**
 * Outcome of evaluating one TLE record, as a discriminated union on `kind`.
 *
 * The previous shape discriminated on `candidate: SatelliteCandidate | null`,
 * which narrowed only because `null` happens to be a unit type — a fragile
 * discriminant that told the reader nothing and let `{ candidate, reason:
 * 'fov' }` (a near miss) and `{ candidate }` (a match) differ by the *absence*
 * of a property. An explicit literal tag makes both the switch below and the
 * intent unambiguous, and makes a new outcome a compile error at every
 * handler rather than a silent fall-through.
 */
type EvaluationResult =
  | { kind: 'rejected'; reason: EvalReason }
  | { kind: 'near-miss'; candidate: SatelliteCandidate }
  | { kind: 'match'; candidate: SatelliteCandidate };

/**
 * True for a finite ECI coordinate triple.
 *
 * satellite.js's .d.ts declares `PositionAndVelocity.position` as a plain
 * `EciVec3<Kilometer>`, but its own doc comment admits the runtime returns
 * `false` on a propagation failure, and SGP4 can emit NaN components for a
 * decayed orbit. Both slip past the compiler. NaN is the worse of the two: it
 * poisons every downstream comparison into `false`, so a broken satellite
 * silently passes the distance and velocity filters instead of being counted
 * as a propagation error.
 */
function isEciVec3(value: unknown): value is satellite.EciVec3<number> {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

/**
 * Propagate a satellite to `date` and return its ECI position, or null when
 * the propagation failed. Typed as `unknown` on the way in on purpose: that is
 * the only way to run a real check against a declaration that over-promises.
 */
function propagatePosition(satrec: satellite.SatRec, date: Date): satellite.EciVec3<number> | null {
  const posVel: unknown = satellite.propagate(satrec, date);
  if (!isRecord(posVel)) return null;
  const position: unknown = posVel.position;
  return isEciVec3(position) ? position : null;
}

/**
 * Normalizes a FITS DATE-OBS-style timestamp to a UTC Date.
 *
 * DATE-OBS is always UTC, but firmware writes it inconsistently: some with a
 * trailing 'Z', some without, some with a numeric offset like '+02:00', and
 * some with a space separator instead of 'T'.
 *
 * IMPORTANT: new Date("2026-06-03T02:18:04") WITHOUT a timezone suffix is
 * parsed as LOCAL time by V8/Node.js, not UTC. A server running in CDT
 * (UTC-5) would shift the search window 5 hours forward, finding nothing.
 * Always append 'Z' unless an explicit timezone offset is already present.
 */
export function normalizeObservationTimestamp(raw: string): Date {
  const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(isoish);
  return new Date(hasTz ? isoish : isoish + 'Z');
}

class SatelliteTracker {
  /**
   * Main entry point: identify which satellite likely caused a trail
   * in an astrophotography image.
   */
  async identifySatelliteTrail(params: ObservationParams, tleRecords?: TLERecord[]): Promise<{ candidates: SatelliteCandidate[]; nearMissFallback: boolean }> {
    const records = tleRecords ?? await satelliteCatalog.loadCatalog();
    const { candidates, nearMisses } = this.filterVisibleSatellites(records, params);

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.matchScore - b.matchScore);
      return { candidates: candidates.slice(0, 10), nearMissFallback: false };
    }

    // Nothing crossed the FOV — satellite is likely not in the public catalog.
    // Return nearest cataloged satellites as a best-effort fallback. The radius
    // scales with the field: a flat 5° is most of the frame on a wide-field rig
    // and many frame-widths on a long-focal-length one, so "near" has to mean
    // "near relative to what this telescope sees".
    if (nearMisses.length > 0) {
      const fovHalfDiag = Math.sqrt(params.fovWidthDeg ** 2 + params.fovHeightDeg ** 2) / 2;
      const nearRadius = Math.max(5, fovHalfDiag * 2);
      const close = nearMisses.filter(c => c.angularDistanceFromCenter < nearRadius);
      if (close.length > 0) {
        close.sort((a, b) => a.matchScore - b.matchScore);
        return { candidates: close.slice(0, 5), nearMissFallback: true };
      }
    }

    return { candidates: [], nearMissFallback: false };
  }

  /**
   * Run the full filtering pipeline over all TLE records and return
   * satellites that could plausibly appear in the image.
   */
  filterVisibleSatellites(
    records: TLERecord[],
    params: ObservationParams,
  ): { candidates: SatelliteCandidate[]; nearMisses: SatelliteCandidate[]; rejections: RejectionTally } {
    const candidates: SatelliteCandidate[] = [];
    const nearMisses: SatelliteCandidate[] = [];
    const rejections = emptyRejectionTally();
    const observationDate = normalizeObservationTimestamp(params.timestamp);
    // Number.isNaN, not the global isNaN: the global coerces its argument, so
    // it answers true for things that are merely un-numeric rather than NaN.
    if (Number.isNaN(observationDate.getTime())) {
      // Give up; downstream code will see no results rather than NaN-time math
      return { candidates: [], nearMisses: [], rejections };
    }

    const TIME_BUFFER_SEC = 5;
    const totalDuration = params.exposureSeconds + TIME_BUFFER_SEC * 2;
    const fovHalfDiag = Math.sqrt(params.fovWidthDeg ** 2 + params.fovHeightDeg ** 2) / 2;

    // The pre-filter used to propagate each record ONCE, at the exposure start,
    // and keep it only if it was within `min(fovHalfDiag + 1.2·duration, 15)°`
    // of the frame centre. Two things went wrong with that:
    //
    //  - The 15° cap made most of a long exposure unreachable. At 1.2°/s only
    //    crossings within ±12.5 s of the shutter opening can start inside 15°,
    //    so a 60 s sub searched ~21% of its own window and a 300 s sub ~4%.
    //    Conventional rigs shoot 120–600 s subs; identification was effectively
    //    a smart-telescope-only feature.
    //  - For a wide field the cap was *below* the frame itself: a lens with a
    //    diagonal over 30° has fovHalfDiag > 15, so satellites visibly inside
    //    the picture were rejected as 'distance'.
    //
    // Instead: walk the whole window at a coarse step and keep the record if it
    // comes within one coarse step's travel of the frame at any point. The
    // sample count is fixed, so a 600 s sub costs the same as a 10 s one, and
    // the radius is derived from the geometry rather than clamped.
    const coarseStepSec = Math.max(0.5, totalDuration / COARSE_MAX_SAMPLES);
    const preFilterRadius = fovHalfDiag + MAX_RATE_DEG_PER_SEC * coarseStepSec;
    const search: SearchWindow = {
      coarseStepSec,
      preFilterRadius,
      fovHalfDiag,
      fovRotationDeg: params.fovRotationDeg ?? DEFAULT_FOV_ROTATION_DEG,
      minFovDeg: Math.max(1e-6, Math.min(params.fovWidthDeg, params.fovHeightDeg)),
    };

    const observerGd: satellite.GeodeticLocation = {
      longitude: satellite.degreesToRadians(params.observerLon),
      latitude: satellite.degreesToRadians(params.observerLat),
      height: 0,
    };

    // Compute Sun position once for illumination checks
    const sunEci = this.getSunPositionECI(observationDate);

    for (const record of records) {
      try {
        const result = this.evaluateSatellite(record, params, observationDate, observerGd, sunEci, search, TIME_BUFFER_SEC, totalDuration);
        switch (result.kind) {
          case 'match': candidates.push(result.candidate); break;
          case 'near-miss': nearMisses.push(result.candidate); break;
          // `rejections` is keyed by the full EvalReason union, so the reason
          // needs no switch of its own — the Record type already proves every
          // reason has a slot.
          case 'rejected': rejections[result.reason]++; break;
          default: assertNever(result, 'Unhandled satellite evaluation outcome');
        }
      } catch {
        // twoline2satrec and the transforms throw on malformed elements; that
        // is the same class of failure as a refused propagation.
        rejections.propagation++;
      }
    }

    return { candidates, nearMisses, rejections };
  }

  private evaluateSatellite(
    record: TLERecord,
    params: ObservationParams,
    observationDate: Date,
    observerGd: satellite.GeodeticLocation,
    sunEci: satellite.EciVec3<number>,
    search: SearchWindow,
    timeBufferSec: number,
    totalDuration: number,
  ): EvaluationResult {
    // (a) Parse TLE
    const satrec = satellite.twoline2satrec(record.line1, record.line2);

    // (b) Orbital period filter: discard non-LEO orbits (> 130 min)
    const meanMotion = satrec.no; // radians per minute
    // A malformed TLE yields a NaN mean motion, and `NaN <= 0` is false — the
    // old check waved it through, and `NaN > 130` waved it through again, so a
    // garbage record reached the propagator instead of being filtered here.
    if (!Number.isFinite(meanMotion) || meanMotion <= 0) {
      return { kind: 'rejected', reason: 'period' };
    }
    const periodMinutes = (2 * Math.PI) / meanMotion;
    if (periodMinutes > 130) {
      return { kind: 'rejected', reason: 'period' };
    }

    const windowStartMs = observationDate.getTime() - timeBufferSec * 1000;

    // Sample RA/DEC at an offset (seconds) from the window start.
    const sampleAt = (t: number): TrackPoint | null => {
      const when = new Date(windowStartMs + t * 1000);
      const eci = propagatePosition(satrec, when);
      if (eci === null) return null;
      const { ra, dec } = this.eciToTopoRaDec(eci, satellite.gstime(when), observerGd);
      return { ra, dec, time: when.toISOString(), t, eci };
    };

    // (c) Coarse scan across the WHOLE window. See the SearchWindow comment in
    // filterVisibleSatellites: evaluating one instant at the shutter opening
    // made most of a long exposure unsearchable.
    let closestCoarse: TrackPoint | null = null;
    let closestCoarseDist = Infinity;
    let propagated = 0;
    for (let t = 0; t <= totalDuration; t += search.coarseStepSec) {
      const point = sampleAt(t);
      if (point === null) continue;
      propagated++;
      const d = this.angularDistance(point.ra, point.dec, params.imageCenterRA, params.imageCenterDEC);
      if (d < closestCoarseDist) {
        closestCoarseDist = d;
        closestCoarse = point;
      }
    }
    if (propagated === 0 || closestCoarse === null) {
      return { kind: 'rejected', reason: 'propagation' };
    }
    if (closestCoarseDist > search.preFilterRadius) {
      return { kind: 'rejected', reason: 'distance' };
    }

    // (d,e) Horizon and illumination, evaluated at the moment of closest
    // approach rather than at the shutter opening. A satellite that rises, or
    // that leaves the Earth's shadow, part-way through a long exposure was
    // previously judged on an instant when it was neither up nor lit.
    const gmst = satellite.gstime(new Date(windowStartMs + closestCoarse.t * 1000));
    const lookAngles = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(closestCoarse.eci, gmst));
    if (lookAngles.elevation < 0) {
      return { kind: 'rejected', reason: 'horizon' };
    }
    if (!this.isIlluminated(closestCoarse.eci, sunEci)) {
      return { kind: 'rejected', reason: 'shadow' };
    }

    // (f) Fine sampling around closest approach. The bracket is one coarse step
    // either side, which is guaranteed to contain the transit: the satellite was
    // inside preFilterRadius = fovHalfDiag + one step's travel at the coarse
    // sample, so it cannot reach and leave the frame outside that bracket.
    //
    // The step adapts to the field. A fixed 0.2 s assumed the ~0.7° Seestar
    // field ("LEO moves ~1°/s and FOV is ~0.7° wide"); on a 0.24° field a
    // transit lasts ~0.2 s and point-sampling missed it outright.
    const localRate = this.estimateRate(sampleAt, closestCoarse.t, search.coarseStepSec);
    const fineStep = Math.min(
      FINE_STEP_MAX_SEC,
      Math.max(FINE_STEP_MIN_SEC, search.minFovDeg / (4 * Math.max(localRate, 0.05))),
    );
    const bracketStart = Math.max(0, closestCoarse.t - search.coarseStepSec);
    const bracketEnd = Math.min(totalDuration, closestCoarse.t + search.coarseStepSec);
    const step = Math.max(fineStep, (bracketEnd - bracketStart) / FINE_MAX_SAMPLES);

    const track: TrackPoint[] = [];
    for (let t = bracketStart; t <= bracketEnd + 1e-9; t += step) {
      const point = sampleAt(t);
      if (point !== null) track.push(point);
    }
    if (track.length === 0) {
      return { kind: 'rejected', reason: 'propagation' };
    }

    let crossesFOV = false;
    let minAngDistToCenter = Infinity;
    let minAngDistTime = closestCoarse.time;
    for (let i = 0; i < track.length; i++) {
      const point = track[i];
      const d = this.angularDistance(point.ra, point.dec, params.imageCenterRA, params.imageCenterDEC);
      if (d < minAngDistToCenter) {
        minAngDistToCenter = d;
        minAngDistTime = point.time;
      }
      if (crossesFOV) continue;
      // Segment test, not a point test — a transit shorter than one step used
      // to fall between samples entirely. See segmentCrossesFOV.
      const next = track[i + 1];
      const hit = next
        ? this.segmentCrossesFOV(point, next, params.imageCenterRA, params.imageCenterDEC, params.fovWidthDeg, params.fovHeightDeg, search.fovRotationDeg)
        : this.satelliteCrossesFOV(point.ra, point.dec, params.imageCenterRA, params.imageCenterDEC, params.fovWidthDeg, params.fovHeightDeg, search.fovRotationDeg);
      if (hit) crossesFOV = true;
    }

    // (g) Angular velocity, from the median of adjacent-sample rates.
    //
    // The old code divided the first-to-last great-circle distance by the
    // window length. That is a chord across a curved path, so it understates
    // the rate more the longer the window: a real ISS pass measured 0.89°/s
    // over a 10 s window but 0.21°/s over a 600 s one, dropping under the
    // 0.3°/s gate below and rejecting the correct satellite as 'slow'.
    const velocityDegPerSec = this.medianRate(track);

    // (h) Velocity filter: must be moving fast enough to create a visible trail
    if (velocityDegPerSec < 0.3) {
      return { kind: 'rejected', reason: 'slow' };
    }

    const publicTrack = toPublicTrack(track);

    if (!crossesFOV) {
      // Return as near-miss so caller can use as fallback
      return {
        kind: 'near-miss',
        candidate: {
          satellite: record.name,
          noradId: record.noradId,
          crossingTimeUTC: minAngDistTime,
          angularDistanceFromCenter: minAngDistToCenter,
          velocityDegPerSec,
          matchScore: minAngDistToCenter * 2 + 10,
          track: publicTrack,
        },
      };
    }

    // (i) Motion direction filter (optional)
    if (params.detectedTrailAngle !== undefined && publicTrack.length >= 2) {
      const motionAngle = this.computeMotionAngle(publicTrack);
      if (motionAngle !== null) {
        let angleDiff = Math.abs(motionAngle - params.detectedTrailAngle);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;
        if (angleDiff > 90) angleDiff = 180 - angleDiff;
        if (angleDiff > 45) {
          return { kind: 'rejected', reason: 'angle' };
        }
      }
    }

    // Closest approach within the fine track is the crossing time.
    const closestDist = minAngDistToCenter;
    const crossingTime = minAngDistTime;

    // Compute match score (lower is better)
    const crossingMs = new Date(crossingTime).getTime();
    const exposureStart = observationDate.getTime();
    const exposureEnd = exposureStart + params.exposureSeconds * 1000;
    const withinExposure = crossingMs >= exposureStart && crossingMs <= exposureEnd;

    const matchScore =
      closestDist * 2 +                            // closer to center = better
      (withinExposure ? 0 : 5);                     // prefer satellites during actual exposure

    return {
      kind: 'match',
      candidate: {
        satellite: record.name,
        noradId: record.noradId,
        crossingTimeUTC: crossingTime,
        angularDistanceFromCenter: closestDist,
        velocityDegPerSec,
        matchScore,
        track: publicTrack,
      },
    };
  }

  /**
   * Instantaneous angular rate near `t`, in degrees per second, used only to
   * choose the fine sampling step. Falls back to a nominal LEO rate when the
   * propagator refuses either probe.
   */
  private estimateRate(
    sampleAt: (t: number) => TrackPoint | null,
    t: number,
    coarseStepSec: number,
  ): number {
    const probe = Math.min(1, coarseStepSec);
    const a = sampleAt(Math.max(0, t - probe / 2));
    const b = sampleAt(t + probe / 2);
    if (a === null || b === null) return 1;
    const dt = b.t - a.t;
    if (dt <= 0) return 1;
    return this.angularDistance(a.ra, a.dec, b.ra, b.dec) / dt;
  }

  /** Median of adjacent-sample angular rates (deg/s). Robust to a single bad
   *  propagation in the middle of a track, and free of the chord-shortening
   *  that an endpoint-to-endpoint rate suffers over a long window. */
  private medianRate(track: TrackPoint[]): number {
    if (track.length < 2) return 0;
    const rates: number[] = [];
    for (let i = 1; i < track.length; i++) {
      const dt = track[i].t - track[i - 1].t;
      if (dt <= 0) continue;
      rates.push(this.angularDistance(track[i - 1].ra, track[i - 1].dec, track[i].ra, track[i].dec) / dt);
    }
    if (rates.length === 0) return 0;
    rates.sort((a, b) => a - b);
    const mid = rates.length >> 1;
    return rates.length % 2 === 1 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  }


  /**
   * Approximate Sun position in ECI coordinates (km) for a given UTC date.
   * Uses low-precision solar position algorithm (accurate to ~1°).
   */
  getSunPositionECI(date: Date): satellite.EciVec3<number> {
    const JD = date.getTime() / 86400000 + 2440587.5;
    const T = (JD - 2451545.0) / 36525;

    // Mean longitude and anomaly (degrees)
    const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360;
    const MRad = M * Math.PI / 180;

    // Equation of center
    const C = (1.914602 - 0.004817 * T) * Math.sin(MRad) +
              (0.019993 - 0.000101 * T) * Math.sin(2 * MRad) +
              0.000289 * Math.sin(3 * MRad);

    // Sun's ecliptic longitude
    const sunLon = (L0 + C) * Math.PI / 180;

    // Obliquity of the ecliptic
    const obliquity = (23.439291 - 0.0130042 * T) * Math.PI / 180;

    // Distance in AU, convert to km
    const AU_KM = 149597870.7;
    const R = (1.000001018 * (1 - 0.016708634 * 0.016708634)) /
              (1 + 0.016708634 * Math.cos(MRad + C * Math.PI / 180)) * AU_KM;

    // ECI coordinates
    const x = R * Math.cos(sunLon);
    const y = R * Math.sin(sunLon) * Math.cos(obliquity);
    const z = R * Math.sin(sunLon) * Math.sin(obliquity);

    const result: satellite.EciVec3<number> = { x, y, z };
    return result;
  }

  /**
   * Convert ECI position to topocentric RA/DEC in degrees, as seen from the
   * observer on the ground.
   */
  eciToTopoRaDec(
    satEci: satellite.EciVec3<number>,
    gmst: number,
    observerGd: satellite.GeodeticLocation,
  ): { ra: number; dec: number } {
    const obsEcf = satellite.geodeticToEcf(observerGd);
    const cosG = Math.cos(gmst);
    const sinG = Math.sin(gmst);
    const obsEci = {
      x: obsEcf.x * cosG - obsEcf.y * sinG,
      y: obsEcf.x * sinG + obsEcf.y * cosG,
      z: obsEcf.z,
    };

    const tx = satEci.x - obsEci.x;
    const ty = satEci.y - obsEci.y;
    const tz = satEci.z - obsEci.z;

    let ra = Math.atan2(ty, tx) * (180 / Math.PI);
    if (ra < 0) ra += 360;
    const dec = Math.atan2(tz, Math.sqrt(tx * tx + ty * ty)) * (180 / Math.PI);

    return { ra, dec };
  }

  /**
   * Great circle angular distance between two points in degrees using
   * the haversine formula.
   */
  angularDistance(ra1: number, dec1: number, ra2: number, dec2: number): number {
    const toRad = Math.PI / 180;
    const dRa = (ra2 - ra1) * toRad;
    const dDec = (dec2 - dec1) * toRad;
    const lat1 = dec1 * toRad;
    const lat2 = dec2 * toRad;

    const a =
      Math.sin(dDec / 2) * Math.sin(dDec / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dRa / 2) * Math.sin(dRa / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return c * (180 / Math.PI);
  }

  /**
   * Project a sky position into the sensor's own axes, in degrees.
   *
   * Returns `u` along the sensor's +x (NAXIS1) axis and `v` along +y, so the
   * FOV test is a plain `|u| < w/2 && |v| < h/2` in a frame that actually
   * matches the pixels. RA wrapping and cos(DEC) foreshortening are handled
   * here; rotation is `rotationDeg`, the sky position angle of +x measured
   * east of north.
   */
  fovOffsets(
    ra: number,
    dec: number,
    centerRA: number,
    centerDEC: number,
    rotationDeg: number = DEFAULT_FOV_ROTATION_DEG,
  ): { u: number; v: number } {
    let deltaRA = ra - centerRA;
    if (deltaRA > 180) deltaRA -= 360;
    if (deltaRA < -180) deltaRA += 360;

    const centerDECRad = centerDEC * (Math.PI / 180);
    // Tangent-plane offsets: east is RA foreshortened by cos(dec), north is DEC.
    const east = deltaRA * Math.cos(centerDECRad);
    const north = dec - centerDEC;

    const rho = rotationDeg * (Math.PI / 180);
    const cosR = Math.cos(rho), sinR = Math.sin(rho);
    // +x axis points at position angle rho: (north, east) = (cos rho, sin rho).
    // +y is 90° further round. At the default rho = 90° this collapses to
    // u = east, v = -north — the axis-aligned test this replaces.
    return {
      u: north * cosR + east * sinR,
      v: -north * sinR + east * cosR,
    };
  }

  /**
   * Check if a satellite's RA/DEC falls within the FOV rectangle,
   * accounting for RA wrapping, cos(DEC) foreshortening and sensor rotation.
   */
  satelliteCrossesFOV(
    ra: number,
    dec: number,
    centerRA: number,
    centerDEC: number,
    fovW: number,
    fovH: number,
    rotationDeg: number = DEFAULT_FOV_ROTATION_DEG,
  ): boolean {
    const { u, v } = this.fovOffsets(ra, dec, centerRA, centerDEC, rotationDeg);
    return Math.abs(u) < fovW / 2 && Math.abs(v) < fovH / 2;
  }

  /**
   * Does the great-circle segment between two consecutive track samples touch
   * the FOV rectangle?
   *
   * Testing sample POINTS alone means a transit shorter than the sampling
   * interval can fall entirely between two samples and be missed — the failure
   * grows as the field narrows, reaching ~29% of otherwise-detectable trails on
   * a 0.24° field. Over one sampling step the apparent path is straight to well
   * under a pixel, so clipping the segment against the rectangle (Liang-Barsky)
   * turns a sampling question into an exact one.
   */
  segmentCrossesFOV(
    a: { ra: number; dec: number },
    b: { ra: number; dec: number },
    centerRA: number,
    centerDEC: number,
    fovW: number,
    fovH: number,
    rotationDeg: number = DEFAULT_FOV_ROTATION_DEG,
  ): boolean {
    const p0 = this.fovOffsets(a.ra, a.dec, centerRA, centerDEC, rotationDeg);
    const p1 = this.fovOffsets(b.ra, b.dec, centerRA, centerDEC, rotationDeg);
    const du = p1.u - p0.u;
    const dv = p1.v - p0.v;

    let tMin = 0, tMax = 1;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;          // parallel to this edge
      const r = q / p;
      if (p < 0) { if (r > tMax) return false; if (r > tMin) tMin = r; }
      else       { if (r < tMin) return false; if (r < tMax) tMax = r; }
      return true;
    };
    const halfW = fovW / 2, halfH = fovH / 2;
    return clip(-du, p0.u + halfW)
      && clip(du, halfW - p0.u)
      && clip(-dv, p0.v + halfH)
      && clip(dv, halfH - p0.v);
  }

  /**
   * Calculate the bearing/angle of satellite motion from track points
   * in degrees (0 = north/+DEC, 90 = east/+RA).
   */
  computeMotionAngle(track: Array<{ ra: number; dec: number; time: string }>): number | null {
    if (track.length < 2) return null;

    const first = track[0];
    const last = track[track.length - 1];

    let dRA = last.ra - first.ra;
    if (dRA > 180) dRA -= 360;
    if (dRA < -180) dRA += 360;

    const avgDECRad = ((first.dec + last.dec) / 2) * (Math.PI / 180);
    const dRAScaled = dRA * Math.cos(avgDECRad);
    const dDEC = last.dec - first.dec;

    const angle = Math.atan2(dRAScaled, dDEC) * (180 / Math.PI);
    return ((angle % 360) + 360) % 360;
  }

  /**
   * Check if a satellite is illuminated by the Sun (not in Earth's shadow).
   */
  isIlluminated(
    satPos: satellite.EciVec3<number>,
    sunPos: satellite.EciVec3<number>,
  ): boolean {
    const EARTH_RADIUS_KM = 6371;

    const satDist = Math.sqrt(satPos.x ** 2 + satPos.y ** 2 + satPos.z ** 2);
    const sunDist = Math.sqrt(sunPos.x ** 2 + sunPos.y ** 2 + sunPos.z ** 2);

    // Angle between satellite and Sun as seen from Earth center
    const dotProduct = satPos.x * sunPos.x + satPos.y * sunPos.y + satPos.z * sunPos.z;
    const cosAngle = dotProduct / (satDist * sunDist);
    const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));

    // If satellite is on the sunlit side, it's illuminated
    if (angle < Math.PI / 2) {
      return true;
    }

    // Check if the satellite is above Earth's shadow cone
    const earthAngularRadius = Math.asin(EARTH_RADIUS_KM / satDist);
    const shadowAngle = Math.PI - Math.asin(EARTH_RADIUS_KM / sunDist);

    return angle < shadowAngle - earthAngularRadius;
  }
}

export const satelliteTracker = new SatelliteTracker();
