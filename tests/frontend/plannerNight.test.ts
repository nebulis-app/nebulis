/**
 * The planner's night math: which stretches of the night are free, how much of
 * it is booked, where a target belongs, and when the moon is up.
 *
 * These are the numbers the hero and the timeline both read from, so a wrong
 * answer here shows up as a wrong plan rather than as a crash.
 */
import { describe, it, expect } from 'vitest';
import SunCalc from 'suncalc';
import {
  bestSlotFor,
  findGaps,
  formatDuration,
  moonPhaseNameFor,
  moonUpIntervals,
  plannedMinutes,
  twilightMarksFor,
} from '../../src/lib/plannerNight';
import type { PlannedSession } from '../../src/lib/api/plannedSessions';

const LAT = 40;
const LON = -105; // Mountain West USA

function session(id: number, startIso: string, endIso: string): PlannedSession {
  return {
    id,
    objectId: `OBJ${id}`,
    objectName: `Object ${id}`,
    ra: 5.59,
    dec: -5.39,
    startTime: startIso,
    endTime: endIso,
    notes: '',
    createdAt: startIso,
    updatedAt: startIso,
  };
}

const NIGHT_START = new Date('2026-01-15T02:00:00Z');
const NIGHT_END = new Date('2026-01-15T12:00:00Z'); // 10 hours

describe('findGaps', () => {
  it('returns the whole window when nothing is scheduled', () => {
    const gaps = findGaps([], NIGHT_START, NIGHT_END, 30);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(600);
  });

  it('finds the stretches either side of a single block', () => {
    const gaps = findGaps(
      [session(1, '2026-01-15T04:00:00Z', '2026-01-15T06:00:00Z')],
      NIGHT_START,
      NIGHT_END,
      30,
    );
    expect(gaps.map(g => g.minutes)).toEqual([120, 360]);
  });

  it('does not manufacture a sliver between back-to-back blocks', () => {
    const gaps = findGaps(
      [
        session(1, '2026-01-15T02:00:00Z', '2026-01-15T04:00:00Z'),
        session(2, '2026-01-15T04:00:00Z', '2026-01-15T06:00:00Z'),
      ],
      NIGHT_START,
      NIGHT_END,
      30,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(360);
  });

  it('merges overlapping blocks before subtracting them', () => {
    const gaps = findGaps(
      [
        session(1, '2026-01-15T03:00:00Z', '2026-01-15T06:00:00Z'),
        session(2, '2026-01-15T04:00:00Z', '2026-01-15T05:00:00Z'),
      ],
      NIGHT_START,
      NIGHT_END,
      30,
    );
    expect(gaps.map(g => g.minutes)).toEqual([60, 360]);
  });

  it('drops gaps shorter than the minimum', () => {
    const gaps = findGaps(
      [
        session(1, '2026-01-15T02:00:00Z', '2026-01-15T04:00:00Z'),
        session(2, '2026-01-15T04:15:00Z', '2026-01-15T12:00:00Z'),
      ],
      NIGHT_START,
      NIGHT_END,
      30,
    );
    expect(gaps).toHaveLength(0);
  });

  it('ignores blocks that fall entirely outside the window', () => {
    const gaps = findGaps(
      [session(1, '2026-01-14T20:00:00Z', '2026-01-14T23:00:00Z')],
      NIGHT_START,
      NIGHT_END,
      30,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(600);
  });
});

describe('plannedMinutes', () => {
  it('sums separate blocks', () => {
    const total = plannedMinutes(
      [
        session(1, '2026-01-15T03:00:00Z', '2026-01-15T04:00:00Z'),
        session(2, '2026-01-15T05:00:00Z', '2026-01-15T06:30:00Z'),
      ],
      NIGHT_START,
      NIGHT_END,
    );
    expect(total).toBe(150);
  });

  it('counts overlapping blocks once rather than double', () => {
    const total = plannedMinutes(
      [
        session(1, '2026-01-15T03:00:00Z', '2026-01-15T05:00:00Z'),
        session(2, '2026-01-15T04:00:00Z', '2026-01-15T06:00:00Z'),
      ],
      NIGHT_START,
      NIGHT_END,
    );
    expect(total).toBe(180);
  });

  it('clips blocks to the window', () => {
    const total = plannedMinutes(
      [session(1, '2026-01-15T01:00:00Z', '2026-01-15T03:00:00Z')],
      NIGHT_START,
      NIGHT_END,
    );
    expect(total).toBe(60);
  });
});

describe('bestSlotFor', () => {
  const base = {
    ra: 5.59,
    dec: -5.39,
    lat: LAT,
    lon: LON,
    windowStart: NIGHT_START,
    windowEnd: NIGHT_END,
    durationMinutes: 90,
  };

  it('picks the slot with the highest mean altitude', () => {
    const slot = bestSlotFor(base);
    expect(slot).not.toBeNull();
    // M42 transits in the small hours in January from this longitude, so the
    // chosen slot must beat both ends of the window.
    const meanAt = (startIso: string) =>
      bestSlotFor({ ...base, windowStart: new Date(startIso), windowEnd: new Date(new Date(startIso).getTime() + 90 * 60_000) })!.meanAlt;
    expect(slot!.meanAlt).toBeGreaterThanOrEqual(meanAt('2026-01-15T02:00:00Z'));
    expect(slot!.meanAlt).toBeGreaterThanOrEqual(meanAt('2026-01-15T10:30:00Z'));
  });

  it('produces a block of exactly the requested length', () => {
    const slot = bestSlotFor(base)!;
    expect((slot.end.getTime() - slot.start.getTime()) / 60_000).toBe(90);
  });

  it('stays inside the window', () => {
    const slot = bestSlotFor(base)!;
    expect(slot.start.getTime()).toBeGreaterThanOrEqual(NIGHT_START.getTime());
    expect(slot.end.getTime()).toBeLessThanOrEqual(NIGHT_END.getTime());
  });

  it('avoids colliding with what is already scheduled', () => {
    const unblocked = bestSlotFor(base)!;
    const busy = [{ start: unblocked.start.getTime(), end: unblocked.end.getTime() }];
    const slot = bestSlotFor({ ...base, busy })!;
    expect(slot.clashes).toBe(false);
    const overlaps = slot.start.getTime() < busy[0].end && busy[0].start < slot.end.getTime();
    expect(overlaps).toBe(false);
  });

  it('reports a clash when every slot is taken', () => {
    const busy = [{ start: NIGHT_START.getTime(), end: NIGHT_END.getTime() }];
    const slot = bestSlotFor({ ...base, busy })!;
    expect(slot.clashes).toBe(true);
  });

  it('returns null when the window cannot hold the block', () => {
    expect(
      bestSlotFor({ ...base, windowEnd: new Date(NIGHT_START.getTime() + 30 * 60_000) }),
    ).toBeNull();
  });
});

describe('moonUpIntervals', () => {
  it('reports the moon up across a window where it never sets', () => {
    // Sample a 2-hour window centred on a moment the moon is known to be up.
    let upMoment: Date | null = null;
    for (let h = 0; h < 24 && !upMoment; h++) {
      const t = new Date(Date.UTC(2026, 0, 15, h, 0, 0));
      if ((SunCalc.getMoonPosition(t, LAT, LON).altitude * 180) / Math.PI > 20) upMoment = t;
    }
    expect(upMoment).not.toBeNull();
    const intervals = moonUpIntervals(
      new Date(upMoment!.getTime() - 30 * 60_000),
      new Date(upMoment!.getTime() + 30 * 60_000),
      LAT,
      LON,
    );
    expect(intervals).toHaveLength(1);
  });

  it('finds a rise crossing to within a couple of minutes of SunCalc', () => {
    const day = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
    const times = SunCalc.getMoonTimes(day, LAT, LON, true);
    if (!times.rise) return; // no rise that day at this latitude
    const intervals = moonUpIntervals(
      new Date(times.rise.getTime() - 2 * 3_600_000),
      new Date(times.rise.getTime() + 2 * 3_600_000),
      LAT,
      LON,
    );
    const found = intervals.find(i => Math.abs(i.start - times.rise!.getTime()) < 5 * 60_000);
    expect(found).toBeDefined();
  });

  it('returns nothing for an inverted window', () => {
    expect(moonUpIntervals(NIGHT_END, NIGHT_START, LAT, LON)).toEqual([]);
  });
});

describe('twilightMarksFor', () => {
  it('orders the evening phases from sunset down to astronomical dark', () => {
    const marks = twilightMarksFor(new Date(2026, 0, 15, 12, 0, 0), LAT, LON);
    expect(marks.sunset).not.toBeNull();
    expect(marks.civilEnd!.getTime()).toBeGreaterThan(marks.sunset!.getTime());
    expect(marks.nauticalEnd!.getTime()).toBeGreaterThan(marks.civilEnd!.getTime());
    expect(marks.astroEnd!.getTime()).toBeGreaterThan(marks.nauticalEnd!.getTime());
  });

  it('takes the morning phases from the following day, so the night is monotonic', () => {
    const marks = twilightMarksFor(new Date(2026, 0, 15, 12, 0, 0), LAT, LON);
    expect(marks.astroStart!.getTime()).toBeGreaterThan(marks.astroEnd!.getTime());
    expect(marks.sunrise!.getTime()).toBeGreaterThan(marks.civilStart!.getTime());
  });
});

describe('moonPhaseNameFor', () => {
  it('names the principal phases the way the server does', () => {
    expect(moonPhaseNameFor(0)).toBe('New Moon');
    expect(moonPhaseNameFor(0.25)).toBe('First Quarter');
    expect(moonPhaseNameFor(0.5)).toBe('Full Moon');
    expect(moonPhaseNameFor(0.75)).toBe('Last Quarter');
    expect(moonPhaseNameFor(0.99)).toBe('New Moon');
  });
});

describe('formatDuration', () => {
  it('formats hours, minutes, and the combination', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(260)).toBe('4h 20m');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-30)).toBe('0m');
  });
});
