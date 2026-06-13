import * as satellite from 'satellite.js';
import { satelliteCatalog, type TLERecord } from './satelliteCatalog.js';

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
    // Return nearest cataloged satellites as a best-effort fallback (within 5°).
    if (nearMisses.length > 0) {
      const close = nearMisses.filter(c => c.angularDistanceFromCenter < 5);
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
  filterVisibleSatellites(records: TLERecord[], params: ObservationParams): { candidates: SatelliteCandidate[]; nearMisses: SatelliteCandidate[] } {
    const candidates: SatelliteCandidate[] = [];
    const nearMisses: SatelliteCandidate[] = [];
    // DATE-OBS in FITS is always UTC. Some firmware writes the value with a
    // trailing 'Z', some without, some with a numeric offset like '+02:00',
    // and some with a space separator instead of 'T'.
    //
    // IMPORTANT: new Date("2026-06-03T02:18:04") WITHOUT a timezone suffix is
    // parsed as LOCAL time by V8/Node.js, not UTC. A server running in CDT
    // (UTC-5) would shift the search window 5 hours forward, finding nothing.
    // Always append 'Z' unless an explicit timezone offset is already present.
    const raw = params.timestamp;
    const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(isoish);
    const observationDate = new Date(hasTz ? isoish : isoish + 'Z');
    if (isNaN(observationDate.getTime())) {
      // Give up; downstream code will see no results rather than NaN-time math
      return { candidates: [], nearMisses: [] };
    }

    const TIME_BUFFER_SEC = 5;
    const totalDuration = params.exposureSeconds + TIME_BUFFER_SEC * 2;
    // Max angular distance a LEO satellite (~1°/s) could cover during the window
    const maxTravelDeg = 1.2 * totalDuration;
    const fovDiag = Math.sqrt(params.fovWidthDeg ** 2 + params.fovHeightDeg ** 2) / 2;
    const preFilterRadius = Math.min(fovDiag + maxTravelDeg, 15);

    const observerGd: satellite.GeodeticLocation = {
      longitude: satellite.degreesToRadians(params.observerLon),
      latitude: satellite.degreesToRadians(params.observerLat),
      height: 0,
    };

    // Compute Sun position once for illumination checks
    const sunEci = this.getSunPositionECI(observationDate);

    let propagationErrors = 0;
    let belowHorizon = 0;
    let tooFar = 0;
    let periodFiltered = 0;
    let noFovCross = 0;
    let angleFiltered = 0;
    let inShadow = 0;
    let tooSlow = 0;

    for (const record of records) {
      try {
        const result = this.evaluateSatellite(record, params, observationDate, observerGd, sunEci, preFilterRadius, TIME_BUFFER_SEC, totalDuration);
        if (result.candidate) {
          if (result.reason === 'fov') {
            nearMisses.push(result.candidate);
          } else {
            candidates.push(result.candidate);
          }
        } else {
          switch (result.reason) {
            case 'horizon': belowHorizon++; break;
            case 'distance': tooFar++; break;
            case 'period': periodFiltered++; break;
            case 'fov': noFovCross++; break;
            case 'angle': angleFiltered++; break;
            case 'shadow': inShadow++; break;
            case 'slow': tooSlow++; break;
          }
        }
      } catch {
        propagationErrors++;
      }
    }

    return { candidates, nearMisses };
  }

  private evaluateSatellite(
    record: TLERecord,
    params: ObservationParams,
    observationDate: Date,
    observerGd: satellite.GeodeticLocation,
    sunEci: satellite.EciVec3<number>,
    preFilterRadius: number,
    timeBufferSec: number,
    totalDuration: number,
  ): { candidate: SatelliteCandidate | null; reason?: string } {
    // (a) Parse TLE
    const satrec = satellite.twoline2satrec(record.line1, record.line2);

    // (b) Orbital period filter: discard non-LEO orbits (> 130 min)
    const meanMotion = satrec.no; // radians per minute
    if (meanMotion <= 0) {
      return { candidate: null, reason: 'period' };
    }
    const periodMinutes = (2 * Math.PI) / meanMotion;
    if (periodMinutes > 130) {
      return { candidate: null, reason: 'period' };
    }

    // (c) Propagate to observation time.
    // The library's .d.ts narrows `position` to EciVec3<number> but the runtime
    // implementation can still return `false` on failure, so we guard before use.
    const posVel = satellite.propagate(satrec, observationDate);
    if (!posVel.position || typeof posVel.position === 'boolean') {
      return { candidate: null, reason: 'propagation' };
    }
    const positionEci = posVel.position;

    // GMST at observation time
    const gmst = satellite.gstime(observationDate);

    // (d) Horizon filter: must be above the horizon
    const positionEcf = satellite.eciToEcf(positionEci, gmst);
    const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);
    if (lookAngles.elevation < 0) {
      return { candidate: null, reason: 'horizon' };
    }

    // (e) Illumination filter: satellite must be sunlit to be visible
    if (!this.isIlluminated(positionEci, sunEci)) {
      return { candidate: null, reason: 'shadow' };
    }

    // (f) Angular distance pre-filter based on max travel during exposure
    const { ra, dec } = this.eciToTopoRaDec(positionEci, gmst, observerGd);
    const angDist = this.angularDistance(ra, dec, params.imageCenterRA, params.imageCenterDEC);
    if (angDist > preFilterRadius) {
      return { candidate: null, reason: 'distance' };
    }

    // (g) Exposure path sampling with buffer
    const track: Array<{ ra: number; dec: number; time: string }> = [];
    let crossesFOV = false;
    let minAngDistToCenter = Infinity;
    let minAngDistTime = '';
    const startTime = observationDate.getTime() - timeBufferSec * 1000;

    // Sample every 0.2s — LEO moves ~1°/s and FOV is ~0.7° wide
    const STEP = 0.2;
    for (let t = 0; t <= totalDuration; t += STEP) {
      const sampleDate = new Date(startTime + t * 1000);
      const samplePosVel = satellite.propagate(satrec, sampleDate);
      if (!samplePosVel.position || typeof samplePosVel.position === 'boolean') {
        continue;
      }
      const sampleEci = samplePosVel.position;
      const sampleGmst = satellite.gstime(sampleDate);
      const sampleRaDec = this.eciToTopoRaDec(sampleEci, sampleGmst, observerGd);

      track.push({
        ra: sampleRaDec.ra,
        dec: sampleRaDec.dec,
        time: sampleDate.toISOString(),
      });

      const d = this.angularDistance(sampleRaDec.ra, sampleRaDec.dec, params.imageCenterRA, params.imageCenterDEC);
      if (d < minAngDistToCenter) {
        minAngDistToCenter = d;
        minAngDistTime = sampleDate.toISOString();
      }

      // Check against actual FOV size (no inflation)
      if (
        this.satelliteCrossesFOV(
          sampleRaDec.ra,
          sampleRaDec.dec,
          params.imageCenterRA,
          params.imageCenterDEC,
          params.fovWidthDeg,
          params.fovHeightDeg,
        )
      ) {
        crossesFOV = true;
      }
    }

    // Compute velocity in deg/sec from the track
    let velocityDegPerSec = 0;
    if (track.length >= 2) {
      const first = track[0];
      const last = track[track.length - 1];
      const totalDist = this.angularDistance(first.ra, first.dec, last.ra, last.dec);
      const elapsedSec = (new Date(last.time).getTime() - new Date(first.time).getTime()) / 1000;
      if (elapsedSec > 0) {
        velocityDegPerSec = totalDist / elapsedSec;
      }
    }

    // (h) Velocity filter: must be moving fast enough to create a visible trail
    if (velocityDegPerSec < 0.3) {
      return { candidate: null, reason: 'slow' };
    }

    if (!crossesFOV) {
      // Return as near-miss so caller can use as fallback
      return {
        candidate: {
          satellite: record.name,
          noradId: record.noradId,
          crossingTimeUTC: minAngDistTime || observationDate.toISOString(),
          angularDistanceFromCenter: minAngDistToCenter,
          velocityDegPerSec,
          matchScore: minAngDistToCenter * 2 + 10,
          track,
        },
        reason: 'fov',
      };
    }

    // (i) Motion direction filter (optional)
    if (params.detectedTrailAngle !== undefined && track.length >= 2) {
      const motionAngle = this.computeMotionAngle(track);
      if (motionAngle !== null) {
        let angleDiff = Math.abs(motionAngle - params.detectedTrailAngle);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;
        if (angleDiff > 90) angleDiff = 180 - angleDiff;
        if (angleDiff > 45) {
          return { candidate: null, reason: 'angle' };
        }
      }
    }

    // Find the track point closest to the image center as the crossing time
    let closestDist = Infinity;
    let crossingTime = observationDate.toISOString();
    for (const point of track) {
      const dist = this.angularDistance(point.ra, point.dec, params.imageCenterRA, params.imageCenterDEC);
      if (dist < closestDist) {
        closestDist = dist;
        crossingTime = point.time;
      }
    }

    // Compute match score (lower is better)
    const crossingMs = new Date(crossingTime).getTime();
    const exposureStart = observationDate.getTime();
    const exposureEnd = exposureStart + params.exposureSeconds * 1000;
    const withinExposure = crossingMs >= exposureStart && crossingMs <= exposureEnd;

    const matchScore =
      closestDist * 2 +                            // closer to center = better
      (withinExposure ? 0 : 5);                     // prefer satellites during actual exposure

    return {
      candidate: {
        satellite: record.name,
        noradId: record.noradId,
        crossingTimeUTC: crossingTime,
        angularDistanceFromCenter: closestDist,
        velocityDegPerSec,
        matchScore,
        track,
      },
    };
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
   * Check if a satellite's RA/DEC falls within the FOV rectangle,
   * accounting for RA wrapping and cos(DEC) foreshortening.
   */
  satelliteCrossesFOV(
    ra: number,
    dec: number,
    centerRA: number,
    centerDEC: number,
    fovW: number,
    fovH: number,
  ): boolean {
    let deltaRA = ra - centerRA;
    if (deltaRA > 180) deltaRA -= 360;
    if (deltaRA < -180) deltaRA += 360;

    const centerDECRad = centerDEC * (Math.PI / 180);
    const adjustedDeltaRA = Math.abs(deltaRA * Math.cos(centerDECRad));
    const deltaDEC = Math.abs(dec - centerDEC);

    return adjustedDeltaRA < fovW / 2 && deltaDEC < fovH / 2;
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
