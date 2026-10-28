// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dateFromKey, localDateKeyOfTimestamp, nightWindowFor, plannerToday, localDateKey } from '../../src/lib/nightWindow';
import { isUpTonight as clientIsUpTonight } from '../../src/lib/bestImagingWindow';
import { isUpTonight as serverIsUpTonight } from '../../server/lib/bestImagingWindow';
import { useLocalToday } from '../../src/hooks/useLocalToday';

/**
 * Every "which day is it" answer must follow a real clock, never the UTC date.
 * The report that started this: at 19:31 CDT (00:31 UTC) the observations
 * calendar said it was already Tuesday.
 */
const CEDAR_RAPIDS = { lat: 41.98, lon: -91.67 };
const MONDAY_EVENING = new Date('2026-10-27T00:31:00Z'); // 19:31 CDT, Monday 26 October

const savedTz = process.env.TZ;
function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try { return fn(); } finally {
    // Assigning undefined to process.env stores the string "undefined".
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('today on the calendar', () => {
  function Today() { return createElement('span', null, useLocalToday()); }

  it('is the viewer local date in the evening, not the UTC date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_EVENING);
    const html = inZone('America/Chicago', () => renderToStaticMarkup(createElement(Today)));
    expect(html).toBe('<span>2026-10-26</span>');
  });
});

describe('localDateKeyOfTimestamp', () => {
  it('converts a zoned instant to the viewer date', () => {
    inZone('America/Chicago', () => {
      expect(localDateKeyOfTimestamp('2026-10-27T00:31:00.000Z')).toBe('2026-10-26');
      expect(localDateKeyOfTimestamp('2026-10-27T07:31:00+02:00')).toBe('2026-10-27');
    });
  });

  it('keeps the date of a naive wall-clock or compact stamp', () => {
    inZone('Asia/Tokyo', () => {
      expect(localDateKeyOfTimestamp('2026-10-27T00:31:00')).toBe('2026-10-27');
      expect(localDateKeyOfTimestamp('20261027-003100')).toBe('2026-10-27');
      expect(localDateKeyOfTimestamp(null)).toBeNull();
      expect(localDateKeyOfTimestamp('unknown')).toBeNull();
    });
  });
});

describe('dark window for a night', () => {
  // The planner names a night by its date at the site. Viewing an Iowa site
  // from a browser in Tokyo or London must give the same window as from Iowa.
  it('is the same whatever zone the browser runs in', () => {
    const windows = ['America/Chicago', 'UTC', 'Asia/Tokyo', 'Pacific/Auckland'].map(tz => inZone(tz, () => {
      const w = nightWindowFor(dateFromKey('2026-10-26'), CEDAR_RAPIDS.lat, CEDAR_RAPIDS.lon);
      return w && { start: w.start.toISOString(), end: w.end.toISOString() };
    }));
    expect(windows[0]).not.toBeNull();
    for (const w of windows) expect(w).toEqual(windows[0]);
    // Astronomical dusk on 26 Oct in Iowa is in the evening of the 26th local.
    expect(inZone('America/Chicago', () => localDateKey(new Date(windows[0]!.start)))).toBe('2026-10-26');
  });

  it('plannerToday follows the site zone it is given', () => {
    const at0230Cdt = new Date('2026-10-27T07:30:00Z');
    expect(inZone('Asia/Tokyo', () => localDateKey(plannerToday(at0230Cdt, 'America/Chicago')))).toBe('2026-10-26');
  });
});

describe('isUpTonight: browser and server agree in the site zone', () => {
  // A UTC server used to roll "tonight" over at 01:00 or 02:00 in the US.
  it('agrees through the small hours, wherever each side runs', () => {
    const instants = ['2026-10-27T00:31:00Z', '2026-10-27T07:30:00Z', '2026-10-27T12:30:00Z'].map(s => new Date(s));
    const targets = [
      { ra: 0.71, dec: 41.27 },  // M31: up in the evening
      { ra: 5.58, dec: -5.39 },  // M42: rises after midnight in October
      { ra: 17.76, dec: -29 },   // galactic centre: down all night in late October
    ];
    for (const now of instants) {
      for (const { ra, dec } of targets) {
        const client = inZone('Europe/London', () =>
          clientIsUpTonight(ra, dec, CEDAR_RAPIDS.lat, CEDAR_RAPIDS.lon, 20, now, 'America/Chicago'));
        const server = inZone('UTC', () =>
          serverIsUpTonight(ra, dec, CEDAR_RAPIDS.lat, CEDAR_RAPIDS.lon, 20, now));
        expect({ now: now.toISOString(), ra, server }).toEqual({ now: now.toISOString(), ra, server: client });
      }
    }
  });
});
