import { describe, it, expect } from 'vitest';
import { buildPlanShareText, type PlanShareData, type PlanShareStrings } from '../../src/lib/planShare';
import { buildListShareText, type ListShareData, type ListShareStrings, type ListShareRow } from '../../src/lib/listShare';
import type { PlannedSession } from '../../src/types';

/** The plain-text export is what gets pasted into a public post, so its wording, order and truncation are pinned. */

const planStrings: PlanShareStrings = {
  title: 'Tonight',
  darkWindowLine: (start, end, hours) => `Dark ${start}-${end} (${hours}h)`,
  moonLine: (percent, phase) => `Moon ${percent}% ${phase}`,
  plannedWith: 'Planned with Nebulis',
  timelineLabel: 'Timeline',
  elevationLabel: 'Elevation',
};

const session = (objectId: string, objectName: string, startTime: string, endTime: string): PlannedSession =>
  ({ objectId, objectName, startTime, endTime }) as unknown as PlannedSession;

const plan = (over: Partial<PlanShareData> = {}): PlanShareData => ({
  sessions: [],
  nightStart: new Date('2026-11-01T22:00:00Z'),
  nightEnd: new Date('2026-11-02T04:30:00Z'),
  date: new Date('2026-11-01T22:00:00Z'),
  moonIllumination: null,
  moonPhase: null,
  observerLat: null,
  observerLon: null,
  timezone: 'UTC',
  ...over,
});

describe('buildPlanShareText', () => {
  it('opens with the title and date, then the dark window, and ends with the sign-off', () => {
    const lines = buildPlanShareText(plan(), planStrings).split('\n');
    expect(lines[0]).toMatch(/^Tonight · .*2026/);
    expect(lines[1]).toBe('Dark 22:00-04:30 (6.5h)');
    expect(lines[lines.length - 1]).toBe('Planned with Nebulis');
  });

  it('includes the moon line only when both illumination and phase are known', () => {
    expect(buildPlanShareText(plan({ moonIllumination: 40, moonPhase: 'Waxing Crescent' }), planStrings)).toContain('Moon 40% Waxing Crescent');
    expect(buildPlanShareText(plan({ moonIllumination: 40, moonPhase: null }), planStrings)).not.toContain('Moon');
    expect(buildPlanShareText(plan({ moonIllumination: null, moonPhase: 'Full Moon' }), planStrings)).not.toContain('Moon');
  });

  it('keeps a moon illumination of 0 (new moon) rather than treating it as missing', () => {
    expect(buildPlanShareText(plan({ moonIllumination: 0, moonPhase: 'New Moon' }), planStrings)).toContain('Moon 0% New Moon');
  });

  it('numbers sessions in start order, whatever order they arrive in, with times and duration', () => {
    const text = buildPlanShareText(plan({
      sessions: [
        session('M42', 'Orion Nebula', '2026-11-02T01:00:00Z', '2026-11-02T03:30:00Z'),
        session('M31', 'Andromeda Galaxy', '2026-11-01T22:30:00Z', '2026-11-02T00:00:00Z'),
      ],
    }), planStrings);
    const rows = text.split('\n').filter(l => /^\d+\./.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('1. ');
    expect(rows[0]).toContain('M31');
    expect(rows[0]).toContain('22:30 – 00:00');
    expect(rows[0]).toContain('(1h 30m)');
    expect(rows[1]).toContain('2. ');
    expect(rows[1]).toContain('M42');
    expect(rows[1]).toContain('01:00 – 03:30');
    expect(rows[1]).toContain('(2h 30m)');
  });

  it('writes whole hours and bare minutes without stray zeros', () => {
    const text = buildPlanShareText(plan({
      sessions: [
        session('M1', 'Crab Nebula', '2026-11-01T22:00:00Z', '2026-11-01T23:00:00Z'),
        session('M2', 'Aquarius Cluster', '2026-11-01T23:00:00Z', '2026-11-01T23:45:00Z'),
      ],
    }), planStrings);
    expect(text).toContain('(1h)');
    expect(text).toContain('(45m)');
  });

  it('shows a dash for an unparseable time and leaves the duration off', () => {
    const text = buildPlanShareText(plan({ sessions: [session('M1', 'Crab Nebula', 'garbage', '2026-11-01T23:00:00Z')] }), planStrings);
    const row = text.split('\n').find(l => l.startsWith('1.'))!;
    expect(row).toContain('— – 23:00');
    expect(row).not.toMatch(/\(\d/);
  });

  it('reads times in the observer zone, not the zone of the machine', () => {
    const text = buildPlanShareText(plan({
      timezone: 'Asia/Kolkata',
      sessions: [session('M31', 'Andromeda Galaxy', '2026-11-01T22:00:00Z', '2026-11-01T23:00:00Z')],
    }), planStrings);
    expect(text).toContain('Dark 03:30-10:00');
    expect(text).toContain('03:30 – 04:30');
  });
});

const listStrings: ListShareStrings = {
  title: 'Observation log',
  totalLine: '3 observations',
  statsAcross: 'Across 2 objects',
  statsDot: '·',
  moreNotShown: n => `+${n} more not shown`,
  sharedFrom: 'Shared from Nebulis',
  objectHeader: 'Object',
  catalogHeader: 'Catalog',
  dateHeader: 'Date',
  observationLog: 'Observation log',
};

const row = (id: string, display: string, catalog: string, dateLabel: string): ListShareRow => ({ id, display, catalog, dateLabel });
const list = (rows: ListShareRow[]): ListShareData => ({ rows, uniqueObjects: 2, sortLabel: 'Sorted by date, newest first', showTelescopeDots: false });

describe('buildListShareText', () => {
  it('starts with the totals and sort, and ends with the sign-off', () => {
    const lines = buildListShareText(list([row('a', 'Orion Nebula', 'M42', 'Oct 8')]), listStrings).split('\n');
    expect(lines.slice(0, 4)).toEqual(['3 observations', 'Across 2 objects', 'Sorted by date, newest first', '']);
    expect(lines[lines.length - 1]).toBe('Shared from Nebulis');
  });

  it('aligns the columns to the widest object and catalog entries', () => {
    const lines = buildListShareText(list([
      row('a', 'Orion Nebula', 'M42', 'Oct 8'),
      row('b', 'Andromeda Galaxy', 'M31', 'Oct 7'),
    ]), listStrings).split('\n').filter(l => /Oct/.test(l));
    expect(lines[0]).toBe('Orion Nebula      M42      Oct 8');
    expect(lines[1]).toBe('Andromeda Galaxy  M31      Oct 7');
    expect(lines[0].indexOf('M42')).toBe(lines[1].indexOf('M31'));
    expect(lines[0].indexOf('Oct')).toBe(lines[1].indexOf('Oct'));
  });

  it('caps the card at 60 rows and says how many were left out', () => {
    const rows = Array.from({ length: 75 }, (_, i) => row(`r${i}`, `Object ${i}`, `NGC ${i}`, 'Oct 1'));
    const text = buildListShareText(list(rows), listStrings);
    expect(text.split('\n').filter(l => /^Object \d/.test(l))).toHaveLength(60);
    expect(text).toContain('Object 59');
    expect(text).not.toContain('Object 60');
    expect(text).toContain('+15 more not shown');
  });

  it('adds no "more" line at exactly 60 rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`r${i}`, `Object ${i}`, 'NGC 1', 'Oct 1'));
    expect(buildListShareText(list(rows), listStrings)).not.toContain('more not shown');
  });

  it('copes with an empty list', () => {
    const text = buildListShareText(list([]), listStrings);
    expect(text).toContain('3 observations');
    expect(text.endsWith('Shared from Nebulis')).toBe(true);
  });
});
