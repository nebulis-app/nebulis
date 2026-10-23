// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../src/i18n';
import { PlanResultInline, PlannedNightEntry } from '../../src/components/calendar/PlanNightBadges';
import type { PlanNightSummary } from '../../src/lib/api/plannedSessions';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const plan = (status: PlanNightSummary['status'], achievedSec: number): PlanNightSummary => ({
  night: '2026-09-05', objectId: 'Sh2-105', objectName: 'Crescent Nebula', libraryObjectIds: ['NGC6888'],
  blocks: 2, plannedSec: 10800, achievedSec, frames: 30, status,
});

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe('PlanResultInline', () => {
  it('shows achieved over planned time with the status in the tooltip', () => {
    const html = render(<PlanResultInline plan={plan('partial', 9600)} isDark />);
    expect(html).toContain('2h 40m/3h');
    expect(html).toContain('Planner: Partly done · 2h 40m of 3h planned (2 blocks)');
  });
});

describe('PlannedNightEntry', () => {
  it('shows a missed plan and links to the Planner', () => {
    const html = render(<PlannedNightEntry plan={plan('missed', 0)} isDark={false} compact />);
    expect(html).toContain('Crescent Nebula');
    expect(html).toContain('Missed · 3h planned');
    expect(html).toContain('href="/planner"');
  });
});
