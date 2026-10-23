import { describe, it, expect } from 'vitest';
import { resolveImagingWindow, hoursInWindow } from '../../src/lib/forecastNights';
import { moonUpSpans } from '../../src/lib/forecastScore';
import type { ForecastHour } from '../../src/lib/api/planner';

/** `at('20:00')` is 20:00 on the 14th; `at('02:00', '15')` is 02:00 the next
 *  day. Fixed dates in UTC so nothing here depends on the machine's timezone. */
const at = (hhmm: string, day: '14' | '15' = '14') => `2026-03-${day}T${hhmm}:00.000Z`;

function hour(time: string): ForecastHour {
  return {
    time, cloudCover: 10, cloudCoverLow: 10, cloudCoverMid: 10, cloudCoverHigh: 10,
    seeing: 2, transparency: 0.8, humidity: 60, temperature: 5, dewPoint: -2,
    wind: 8, visibility: 20, precipProb: 0, jetStream: 20, cape: 0,
  };
}

const FULL_TWILIGHT = {
  astronomicalTwilightEnd: at('20:00'),
  astronomicalTwilightStart: at('05:00', '15'),
  nauticalTwilightEnd: at('19:00'),
  nauticalTwilightStart: at('06:00', '15'),
};

describe('resolveImagingWindow', () => {
  it('prefers astronomical twilight and says so', () => {
    const w = resolveImagingWindow(FULL_TWILIGHT);
    expect(w).toEqual({
      startIso: at('20:00'),
      endIso: at('05:00', '15'),
      startMs: Date.parse(at('20:00')),
      endMs: Date.parse(at('05:00', '15')),
      astronomical: true,
    });
  });

  it('falls back to nautical twilight, flagged as not astronomical', () => {
    // A high-latitude summer night: the Sun never reaches -18°, so the server
    // sends no astronomical darkness at all.
    const w = resolveImagingWindow({
      astronomicalTwilightEnd: null,
      astronomicalTwilightStart: null,
      nauticalTwilightEnd: at('19:00'),
      nauticalTwilightStart: at('06:00', '15'),
    });
    expect(w?.astronomical).toBe(false);
    expect(w?.startMs).toBe(Date.parse(at('19:00')));
    expect(w?.endMs).toBe(Date.parse(at('06:00', '15')));
  });

  it('returns null when neither twilight pair is present', () => {
    expect(resolveImagingWindow({})).toBeNull();
    expect(resolveImagingWindow({
      astronomicalTwilightEnd: null,
      astronomicalTwilightStart: null,
      nauticalTwilightEnd: null,
      nauticalTwilightStart: null,
    })).toBeNull();
  });

  it('returns null for an inverted window', () => {
    // The server can hand back the following night's dawn ahead of tonight's
    // dusk at high latitudes in summer.
    expect(resolveImagingWindow({
      astronomicalTwilightEnd: at('05:00', '15'),
      astronomicalTwilightStart: at('20:00'),
    })).toBeNull();
  });

  it('returns null for a zero-length window', () => {
    expect(resolveImagingWindow({
      astronomicalTwilightEnd: at('20:00'),
      astronomicalTwilightStart: at('20:00'),
    })).toBeNull();
  });

  it('returns null when a time cannot be parsed', () => {
    expect(resolveImagingWindow({
      astronomicalTwilightEnd: 'not a time',
      astronomicalTwilightStart: at('05:00', '15'),
    })).toBeNull();
  });
});

describe('hoursInWindow', () => {
  const win = resolveImagingWindow({
    astronomicalTwilightEnd: at('20:00'),
    astronomicalTwilightStart: at('23:00'),
  })!;

  it('includes both bounds and excludes everything outside them', () => {
    const hours = [
      hour(at('18:00')), hour(at('19:00')),
      hour(at('20:00')), hour(at('21:00')), hour(at('22:00')), hour(at('23:00')),
      hour(at('00:00', '15')), hour(at('05:00', '15')),
    ];
    expect(hoursInWindow(hours, win).map(h => h.time)).toEqual([
      at('20:00'), at('21:00'), at('22:00'), at('23:00'),
    ]);
  });

  it('returns an empty list when no hour falls inside', () => {
    expect(hoursInWindow([hour(at('12:00')), hour(at('13:00'))], win)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const hours = [hour(at('21:00')), hour(at('03:00'))];
    const before = hours.map(h => h.time);
    hoursInWindow(hours, win);
    expect(hours.map(h => h.time)).toEqual(before);
  });
});

describe('moonUpSpans', () => {
  const t0 = Date.parse(at('20:00'));
  const t1 = Date.parse(at('05:00', '15'));

  it('reports nothing when rise and set are both unknown', () => {
    // Callers must not read this as "down all night": the imaging window table
    // checks the inputs before claiming anything.
    expect(moonUpSpans(t0, t1, null, null)).toEqual([]);
  });

  it('spans rise to set when the Moon is down as the window opens', () => {
    expect(moonUpSpans(t0, t1, at('23:00'), at('02:00', '15'))).toEqual([
      [Date.parse(at('23:00')), Date.parse(at('02:00', '15'))],
    ]);
  });

  it('splits into two spans when the Moon is already up and comes back', () => {
    // Up at dusk, sets at 22:00, rises again at 02:00.
    expect(moonUpSpans(t0, t1, at('02:00', '15'), at('22:00'))).toEqual([
      [t0, Date.parse(at('22:00'))],
      [Date.parse(at('02:00', '15')), t1],
    ]);
  });

  it('clips a span that starts before the window opens', () => {
    expect(moonUpSpans(t0, t1, at('14:00'), at('22:00'))).toEqual([
      [t0, Date.parse(at('22:00'))],
    ]);
  });

  it('drops a span that lies entirely outside the window', () => {
    // Up in daylight only: this is the case that used to be flagged all night.
    expect(moonUpSpans(t0, t1, at('08:00'), at('17:00'))).toEqual([]);
  });

  it('clips to the window edge when only the rise or only the set is known', () => {
    expect(moonUpSpans(t0, t1, at('23:00'), null)).toEqual([[Date.parse(at('23:00')), t1]]);
    expect(moonUpSpans(t0, t1, null, at('22:00'))).toEqual([[t0, Date.parse(at('22:00'))]]);
  });
});
