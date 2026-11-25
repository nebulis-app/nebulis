import { describe, it, expect } from 'vitest';
import { formatInZone, scheduleNextRunLines } from '../../src/components/settings/archiveForm';

// Echoes the key and its values, so the test reads what the line would say.
const t = ((key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`) as never;

describe('the next-run line under a saved schedule', () => {
  const view = { timeZone: 'Europe/Paris', timeZoneSource: 'installation' as const, nextRunAt: '2026-11-26T02:00:00.000Z' };

  it('says nothing when the schedule is off or unknown', () => {
    expect(scheduleNextRunLines(t, view, false)).toEqual([]);
    expect(scheduleNextRunLines(t, undefined, true)).toEqual([]);
  });

  it('gives the next run in the zone the schedule runs in', () => {
    const [line] = scheduleNextRunLines(t, view, true);
    expect(line).toContain('archive.summary.nextRun');
    expect(line).toContain('"zone":"Europe/Paris"');
    // 02:00 UTC is 03:00 in Paris in November.
    expect(line).toMatch(/03[:.h]00/);
  });

  it("adds a note when the zone is only the server's", () => {
    const lines = scheduleNextRunLines(t, { ...view, timeZone: 'UTC', timeZoneSource: 'server' }, true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('archive.summary.serverZone');
  });

  it('falls back to the browser zone for a zone Intl rejects, instead of throwing', () => {
    expect(() => formatInZone('2026-11-26T02:00:00.000Z', 'Mars/Olympus_Mons')).not.toThrow();
  });
});
