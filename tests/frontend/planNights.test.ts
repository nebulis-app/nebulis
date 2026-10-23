import { describe, it, expect } from 'vitest';
import { indexPlanByDate } from '../../src/lib/planNights';
import type { PlanNightSummary } from '../../src/lib/api/plannedSessions';

const summary = (night: string, objectId: string, libraryObjectIds: string[], status: PlanNightSummary['status'] = 'done'): PlanNightSummary => ({
  night, objectId, objectName: objectId, libraryObjectIds, blocks: 1, plannedSec: 3600, achievedSec: 3000, frames: 10, status,
});

describe('indexPlanByDate', () => {
  it('attaches plans to the observation of the same object and night, the rest stay unmatched', () => {
    const idx = indexPlanByDate(
      [
        summary('2026-09-05', 'Sh2-105', ['NGC6888']),
        summary('2026-09-05', 'M31', [], 'missed'),
        summary('2026-09-06', 'Sh2-105', ['NGC6888'], 'missed'),
      ],
      new Map([['2026-09-05', ['NGC6888', 'IC5146']]]),
    );
    expect(idx.get('2026-09-05')!.byObject.get('NGC6888')!.objectId).toBe('Sh2-105');
    expect(idx.get('2026-09-05')!.unmatched.map(s => s.objectId)).toEqual(['M31']);
    expect(idx.get('2026-09-06')!.byObject.size).toBe(0);
    expect(idx.get('2026-09-06')!.unmatched).toHaveLength(1);
  });

  it('matches on the catalog id when the library object uses it directly', () => {
    const idx = indexPlanByDate([summary('2026-09-05', 'M42', [])], new Map([['2026-09-05', ['M42']]]));
    expect(idx.get('2026-09-05')!.byObject.has('M42')).toBe(true);
  });
});
