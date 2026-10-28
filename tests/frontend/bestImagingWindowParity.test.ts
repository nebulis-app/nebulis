import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  computeBestImagingWindow as clientCompute,
  isUpTonight as clientIsUpTonight,
} from '../../src/lib/bestImagingWindow';
import {
  computeBestImagingWindow as serverCompute,
  isUpTonight as serverIsUpTonight,
} from '../../server/lib/bestImagingWindow';
import { lookupTimeZoneForCoordinates } from '../../server/lib/observerTimezone';

/**
 * Cross-implementation parity test.
 *
 * server/lib/bestImagingWindow.ts's header comment calls itself a "Server-side
 * port of src/lib/bestImagingWindow.ts", used so native clients (iOS, Android)
 * get the same answer the browser computes locally. Unlike altAz (which has
 * tests/frontend/altaz.test.ts pinning client and server to the same output),
 * these two had no cross-check at all before this file: each only had its own
 * independent unit test, so the two copies could silently diverge (different
 * windowStart/windowEnd, a different peak month) and nothing would fail.
 *
 * The client has no way to inject "now" (it always reads `new Date()`), so we
 * pin the clock with fake timers and pass the same instant to the server call.
 */
const REFERENCE_DATE = new Date('2025-06-21T12:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

function comparableMonths(months: { label: string; maxAlt: number; aboveMinAlt: boolean }[]) {
  // Drop the client-only `date` field; compare only what both sides expose.
  return months.map(({ label, maxAlt, aboveMinAlt }) => ({ label, maxAlt, aboveMinAlt }));
}

describe('computeBestImagingWindow client port matches server implementation', () => {
  it('agrees on a hand-picked set of canonical target/observer pairs', () => {
    const cases = [
      { ra: 5.58, dec: -5.39, lat: 40.7128, lon: -74.006, minAlt: 20 },  // M42, NYC
      { ra: 0.71, dec: 41.27, lat: 51.5074, lon: -0.1278, minAlt: 20 }, // M31, London
      { ra: 12, dec: -30, lat: -33.8688, lon: 151.2093, minAlt: 20 },   // Sydney, southern target
      { ra: 18, dec: 60, lat: 64.1466, lon: -21.9426, minAlt: 30 },     // high-latitude Reykjavik
      { ra: 23.99, dec: -89.9, lat: -89, lon: 179, minAlt: 20 },        // extreme south pole target
      { ra: 6, dec: 89, lat: 40.7128, lon: -74.006, minAlt: 20 },       // near-circumpolar
    ];

    for (const { ra, dec, lat, lon, minAlt } of cases) {
      vi.useFakeTimers();
      vi.setSystemTime(REFERENCE_DATE);
      const client = clientCompute(ra, dec, lat, lon, minAlt, lookupTimeZoneForCoordinates(lat, lon) ?? undefined);
      vi.useRealTimers();

      const server = serverCompute(ra, dec, lat, lon, minAlt, REFERENCE_DATE);

      expect(comparableMonths(client.months)).toEqual(comparableMonths(server.months));
      expect(client.windowStart).toBe(server.windowStart);
      expect(client.windowEnd).toBe(server.windowEnd);
      expect(client.everVisible).toBe(server.everVisible);
    }
  });

  it('agrees at a different reference instant, so the parity is not an artifact of one fixed date', () => {
    const other = new Date('2025-12-01T00:00:00Z');
    const ra = 5.58, dec = -5.39, lat = 40.7128, lon = -74.006, minAlt = 20;

    vi.useFakeTimers();
    vi.setSystemTime(other);
    const client = clientCompute(ra, dec, lat, lon, minAlt, lookupTimeZoneForCoordinates(lat, lon) ?? undefined);
    vi.useRealTimers();

    const server = serverCompute(ra, dec, lat, lon, minAlt, other);

    expect(comparableMonths(client.months)).toEqual(comparableMonths(server.months));
    expect(client.windowStart).toBe(server.windowStart);
    expect(client.windowEnd).toBe(server.windowEnd);
  });
});

describe('isUpTonight client port matches server implementation', () => {
  // Both sides anchor "tonight" on the SITE's wall clock with a 07:00 rollover
  // (plannerToday(now, timeZone) in src/lib/nightWindow.ts; observingNightAnchor
  // in server/lib/bestImagingWindow.ts, with the zone looked up from the
  // coordinates). They used to read the machine's own clock instead, so a
  // server in UTC (Docker) rolled over at 02:00 in New York and asked about the
  // wrong night until dawn. The instants below are written in UTC and mean
  // New York wall-clock times, so the result cannot depend on the test
  // machine's zone. This target/night genuinely flips across the boundary
  // (confirmed by direct search), so it exercises the rollover rather than
  // happening to agree either way.
  const RA = 10.6, DEC = 15, LAT = 40.7128, LON = -74.006, MIN_ALT = 60;
  const NYC = 'America/New_York';
  const client = (now: Date) => clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, now, NYC);
  const server = (now: Date) => serverIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, now);

  it('agrees for a call in the early hours, still inside the previous evening\'s window', () => {
    const at2am = new Date('2025-11-22T07:00:00Z'); // Nov 22, 02:00 EST
    expect(client(at2am)).toBe(server(at2am));
  });

  it('agrees right at the 07:00 rollover boundary, on both sides of it', () => {
    const justBefore = new Date('2025-11-22T11:59:00Z'); // 06:59 EST
    const justAfter = new Date('2025-11-22T12:00:00Z');  // 07:00 EST

    expect(client(justBefore)).toBe(server(justBefore));
    expect(client(justAfter)).toBe(server(justAfter));
    // And the rollover actually changes the answer for this fixture, so the
    // test above is not vacuously true.
    expect(client(justBefore)).not.toBe(client(justAfter));
  });

  it('agrees during the evening, well away from the rollover', () => {
    const evening = new Date('2025-11-22T01:00:00Z'); // Nov 21, 20:00 EST
    expect(client(evening)).toBe(server(evening));
  });
});
