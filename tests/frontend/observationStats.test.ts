import { describe, it, expect } from 'vitest';
import {
  summarize,
  bucketByMonth,
  yearsWithObservations,
  nearestObservedDate,
} from '../../src/lib/observationStats';
import type { ObservationSummary } from '../../src/lib/api/observations';

/** Only the fields these functions read; the rest of the summary is irrelevant. */
function obs(date: string, objectId: string, fileCount = 0): ObservationSummary {
  return {
    id: `${objectId}-${date}`,
    objectId,
    objectName: objectId,
    catalogId: objectId,
    type: 'Nebula',
    constellation: 'Orion',
    date,
    startTime: null,
    endTime: null,
    fileCount,
    stackedCount: 0,
    fitsCount: 0,
    subFrameCount: 0,
    processedCount: 0,
    thumbnailUrl: '',
    ra: null,
    dec: null,
    hasNotes: false,
    telescopeId: null,
  };
}

describe('summarize', () => {
  it('counts a night once when several objects were shot on it', () => {
    // The distinction the hero's two headline numbers rest on: three sessions
    // on one night is one night out, not three.
    const totals = summarize([
      obs('2026-03-21', 'M42'),
      obs('2026-03-21', 'M31'),
      obs('2026-03-21', 'M13'),
    ]);
    expect(totals.sessions).toBe(3);
    expect(totals.nights).toBe(1);
    expect(totals.objects).toBe(3);
  });

  it('counts an object once across the nights it was revisited', () => {
    const totals = summarize([
      obs('2026-03-21', 'M42'),
      obs('2026-04-02', 'M42'),
    ]);
    expect(totals.objects).toBe(1);
    expect(totals.nights).toBe(2);
  });

  it('sums files and spans first to last date', () => {
    const totals = summarize([
      obs('2026-04-02', 'M42', 120),
      obs('2025-11-08', 'M31', 80),
      obs('2026-01-11', 'M13', 40),
    ]);
    expect(totals.files).toBe(240);
    expect(totals.firstDate).toBe('2025-11-08');
    expect(totals.lastDate).toBe('2026-04-02');
  });

  it('reports an empty record without inventing a span', () => {
    const totals = summarize([]);
    expect(totals).toEqual({
      sessions: 0, nights: 0, objects: 0, files: 0, firstDate: null, lastDate: null,
    });
  });
});

describe('bucketByMonth', () => {
  it('always returns twelve months so the chart keeps its shape', () => {
    const buckets = bucketByMonth([obs('2026-08-11', 'M42')], 2026);
    expect(buckets).toHaveLength(12);
    expect(buckets.map(b => b.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('separates sessions from nights within a month', () => {
    const buckets = bucketByMonth([
      obs('2026-08-11', 'M42'),
      obs('2026-08-11', 'M31'),
      obs('2026-08-24', 'M13'),
    ], 2026);
    expect(buckets[7]).toEqual({ month: 7, sessions: 3, nights: 2 });
  });

  it('ignores other years', () => {
    const buckets = bucketByMonth([
      obs('2025-08-11', 'M42'),
      obs('2026-08-11', 'M31'),
    ], 2026);
    expect(buckets[7].sessions).toBe(1);
  });

  it('leaves an unobserved month at zero rather than omitting it', () => {
    const buckets = bucketByMonth([obs('2026-08-11', 'M42')], 2026);
    expect(buckets[4]).toEqual({ month: 4, sessions: 0, nights: 0 });
  });
});

describe('yearsWithObservations', () => {
  it('lists each year once, oldest first', () => {
    expect(yearsWithObservations([
      obs('2026-08-11', 'M42'),
      obs('2024-01-02', 'M31'),
      obs('2026-01-05', 'M13'),
      obs('2025-06-06', 'M8'),
    ])).toEqual([2024, 2025, 2026]);
  });

  it('is empty for an empty record', () => {
    expect(yearsWithObservations([])).toEqual([]);
  });
});

describe('nearestObservedDate', () => {
  const dates = ['2025-11-08', '2026-01-11', '2026-08-11'];

  it('finds the closest night in either direction', () => {
    expect(nearestObservedDate(dates, '2026-01-09')).toBe('2026-01-11');
    expect(nearestObservedDate(dates, '2026-06-15')).toBe('2026-08-11');
    expect(nearestObservedDate(dates, '2025-11-20')).toBe('2025-11-08');
  });

  it('returns the date itself when it was observed', () => {
    expect(nearestObservedDate(dates, '2026-01-11')).toBe('2026-01-11');
  });

  it('breaks an exact tie towards the past', () => {
    // A night already recorded is a better place to land than one that has not
    // happened, so equidistant resolves backwards.
    expect(nearestObservedDate(['2026-01-01', '2026-01-03'], '2026-01-02')).toBe('2026-01-01');
  });

  it('has nothing to offer with no dates', () => {
    expect(nearestObservedDate([], '2026-01-02')).toBeNull();
  });
});
