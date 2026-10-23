// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { PlanOutcomeActions, PlanOutcomeChip, PlanOutcomeIcon } from '../../src/components/planner/PlanOutcomeBadge';
import type { PlannedSession, PlanOutcome } from '../../src/lib/api/plannedSessions';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const outcome = (status: PlanOutcome['status'], achievedSec = 0, frames = 0): PlanOutcome =>
  ({ status, plannedSec: 10800, achievedSec, frames });

function session(o: PlanOutcome): PlannedSession {
  return {
    id: 1, objectId: 'Sh2-105', objectName: 'Crescent', ra: 20.2, dec: 38.3,
    startTime: '2026-09-05T20:00:00.000Z', endTime: '2026-09-05T23:00:00.000Z',
    notes: '', framingSetup: null, skipped: o.status === 'skipped' ? 1 : 0,
    outcome: o, createdAt: '', updatedAt: '',
  };
}

const render = (el: React.ReactElement) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>,
);

describe('PlanOutcomeChip', () => {
  it('shows achieved over planned time, or the status for missed/skipped', () => {
    expect(render(<PlanOutcomeChip outcome={outcome('partial', 6000, 20)} />)).toContain('1h 40m / 3h');
    expect(render(<PlanOutcomeChip outcome={outcome('partial', 6000, 20)} />)).toContain('20 sub-frames in the library');
    expect(render(<PlanOutcomeChip outcome={outcome('missed')} />)).toContain('>Missed<');
    expect(render(<PlanOutcomeChip outcome={outcome('skipped')} />)).toContain('>Skipped<');
    expect(render(<PlanOutcomeChip outcome={outcome('upcoming')} />)).toBe('');
    expect(render(<PlanOutcomeChip outcome={null} />)).toBe('');
  });
});

describe('PlanOutcomeIcon', () => {
  it('labels ended blocks and stays empty for upcoming ones', () => {
    expect(render(<PlanOutcomeIcon outcome={outcome('done', 10800)} />)).toContain('aria-label="Done"');
    expect(render(<PlanOutcomeIcon outcome={outcome('upcoming')} />)).toBe('');
  });
});

describe('PlanOutcomeActions', () => {
  it('offers to plan again for missed and partial blocks, and to skip or unskip', () => {
    const missed = render(<PlanOutcomeActions session={session(outcome('missed'))} />);
    expect(missed).toContain('Plan again the next night');
    expect(missed).toContain('Mark as skipped');
    const partial = render(<PlanOutcomeActions session={session(outcome('partial', 3600, 10))} />);
    expect(partial).toContain('Plan again the next night');
    expect(partial).not.toContain('Mark as skipped');
    expect(render(<PlanOutcomeActions session={session(outcome('skipped'))} />)).toContain('Unmark skipped');
    expect(render(<PlanOutcomeActions session={session(outcome('done', 10800, 60))} />)).toBe('');
    expect(render(<PlanOutcomeActions session={session(outcome('upcoming'))} />)).toBe('');
  });
});
