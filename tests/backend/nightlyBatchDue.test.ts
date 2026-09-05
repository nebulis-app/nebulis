import { describe, it, expect } from 'vitest';
import { isNightlyBatchDue } from '../../server/lib/plannerNightlyPrefetch';

// The scheduler ticks every 60s and calls isNightlyBatchDue(now, "03:00", tz, lastRanDate).
describe('isNightlyBatchDue', () => {
  const tz = 'UTC';

  it('is not due before the target time', () => {
    expect(isNightlyBatchDue(new Date('2026-06-21T02:59:00Z'), '03:00', tz, null)).toBe(false);
  });

  it('is due on the first tick at or after the target time', () => {
    expect(isNightlyBatchDue(new Date('2026-06-21T03:00:00Z'), '03:00', tz, null)).toBe(true);
    expect(isNightlyBatchDue(new Date('2026-06-21T03:00:30Z'), '03:00', tz, null)).toBe(true);
  });

  it('still runs hours later if the window was missed (the ±1-minute bug)', () => {
    // Process asleep 02:00-09:00; wakes at 09:00 having never run today.
    expect(isNightlyBatchDue(new Date('2026-06-21T09:00:00Z'), '03:00', tz, '2026-06-20')).toBe(true);
  });

  it('does not run twice on the same local day', () => {
    expect(isNightlyBatchDue(new Date('2026-06-21T05:00:00Z'), '03:00', tz, '2026-06-21')).toBe(false);
  });

  it('resets for the next local day', () => {
    expect(isNightlyBatchDue(new Date('2026-06-22T03:01:00Z'), '03:00', tz, '2026-06-21')).toBe(true);
  });

  it('respects the site timezone, not the server clock', () => {
    // 2026-06-21T08:00Z is 01:00 in America/Denver (UTC-6 DST) — before 03:00 local.
    expect(isNightlyBatchDue(new Date('2026-06-21T08:00:00Z'), '03:00', 'America/Denver', null)).toBe(false);
    // 2026-06-21T10:00Z is 04:00 local — due.
    expect(isNightlyBatchDue(new Date('2026-06-21T10:00:00Z'), '03:00', 'America/Denver', null)).toBe(true);
  });
});
