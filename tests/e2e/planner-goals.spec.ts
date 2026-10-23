import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, MOCK, json, ok } from './fixtures/mocks';

/**
 * Plan My Night with integration goals, and plan versus actual on the schedule.
 *
 * What gets picked is the server's job (server/lib/autoPlan.ts, covered by
 * tests/backend/autoPlan.test.ts, including the rule that a goal bonus never
 * beats a target far higher in the sky). These specs pin what the screens send
 * and how they show what comes back.
 */

const progress = {
  objectId: 'M42',
  filters: [
    { filter: 'Ha', goalSec: 36000, exposureSec: 7200, remainingSec: 28800 },
    { filter: 'OIII', goalSec: 18000, exposureSec: 18000, remainingSec: 0 },
  ],
  complete: false,
};

function planBlock(offsetHours: number) {
  const start = Date.now() + offsetHours * 3_600_000;
  return {
    target: {
      id: 'M42', name: 'Orion Nebula', type: 'Emission Nebula', ra: 5.58, dec: -5.39, magnitude: 4, majorAxisArcmin: 85,
      constellation: 'Orion', commonNames: ['Orion Nebula'], isAlreadyImaged: true,
    },
    start: new Date(start).toISOString(),
    end: new Date(start + 90 * 60_000).toISOString(),
    meanAlt: 52,
    moonSeparation: 70,
    moonVerdict: 'ok',
    filterBand: 'narrowband',
    filter: 'Ha',
    filterRemainingSec: 28800,
    sky: null,
  };
}

/** Records what Plan My Night posts, and answers with one block plus a goals summary. */
async function mockPlan(page: Page, goalsComplete: { id: string; name: string }[] = []) {
  const posted: { body: Record<string, unknown> | null } = { body: null };
  await page.route('**/api/planner/plan', async r => {
    posted.body = r.request().postDataJSON();
    await r.fulfill(json({
      ok: true,
      data: [planBlock(1)],
      meta: { goals: { requested: posted.body?.favorGoals === true, complete: goalsComplete } },
    }));
  });
  return posted;
}

async function openPlanMyNight(page: Page) {
  await page.getByRole('button', { name: 'Plan my night' }).first().click();
  await expect(page.getByRole('heading', { name: 'Plan My Night' })).toBeVisible();
}

test.describe('Plan My Night: goals', () => {
  test('offers no goals switch when no object has a goal', async ({ page }) => {
    await mockAllRoutes(page);
    await page.route('**/api/library/integration/progress', r => r.fulfill(json(ok([]))));
    await page.goto('/planner');
    await openPlanMyNight(page);
    await expect(page.getByLabel('Favour objects with time left toward their goals')).toHaveCount(0);
  });

  test.describe('with a goal on Orion', () => {
    test.beforeEach(async ({ page }) => {
      await mockAllRoutes(page);
      await page.route('**/api/library/integration/progress', r => r.fulfill(json(ok([progress]))));
      await page.goto('/planner');
      await openPlanMyNight(page);
    });

    test('the switch is on by default', async ({ page }) => {
      await expect(page.getByLabel('Favour objects with time left toward their goals')).toBeChecked();
    });

    test('building sends the goals with the candidates and asks the server to favour them', async ({ page }) => {
      const posted = await mockPlan(page);
      await page.getByRole('button', { name: 'Build my plan' }).click();
      await expect(page.getByText('Add to', { exact: false }).first()).toBeVisible();

      expect(posted.body?.favorGoals).toBe(true);
      const targets = posted.body?.targets as { id: string; goals?: unknown[] }[];
      expect(targets.find(t => t.id === 'M42')?.goals).toEqual([
        { filter: 'Ha', goalSec: 36000, remainingSec: 28800 },
        { filter: 'OIII', goalSec: 18000, remainingSec: 0 },
      ]);
      // An object with no goal is sent as it always was.
      expect(targets.find(t => t.id === 'M45')?.goals).toBeUndefined();
    });

    test('switching it off plans exactly as before: no goals sent, nothing favoured', async ({ page }) => {
      const posted = await mockPlan(page);
      await page.getByLabel('Favour objects with time left toward their goals').uncheck();
      await page.getByRole('button', { name: 'Build my plan' }).click();
      await expect(page.getByText('Add to', { exact: false }).first()).toBeVisible();

      expect(posted.body?.favorGoals).toBe(false);
      const targets = posted.body?.targets as { goals?: unknown[] }[];
      expect(targets.every(t => t.goals === undefined)).toBe(true);
    });

    test('the preview says how much time is left on the filter each block uses', async ({ page }) => {
      await mockPlan(page);
      await page.getByRole('button', { name: 'Build my plan' }).click();
      await expect(page.getByText('8h left · Ha')).toBeVisible();
    });

    test('the preview names the objects left out because their goals are reached', async ({ page }) => {
      await mockPlan(page, [{ id: 'M45', name: 'Pleiades' }]);
      await page.getByRole('button', { name: 'Build my plan' }).click();
      await expect(page.getByText(/Goals reached, left out: .*Pleiades/)).toBeVisible();
    });

    test('says nothing about finished objects when none were left out', async ({ page }) => {
      await mockPlan(page, []);
      await page.getByRole('button', { name: 'Build my plan' }).click();
      await expect(page.getByText('8h left · Ha')).toBeVisible();
      await expect(page.getByText(/Goals reached, left out/)).toHaveCount(0);
    });
  });
});

test.describe('Plan versus actual on the schedule', () => {
  type Outcome = { status: string; plannedSec: number; achievedSec: number; frames: number };
  const at = (offsetHours: number) => new Date(Date.now() + offsetHours * 3_600_000).toISOString();

  /** One planned block per outcome, spaced out so none overlap on the timeline. */
  function session(id: number, name: string, offsetHours: number, outcome: Outcome | null, extra: Record<string, unknown> = {}) {
    return {
      id, objectId: `OBJ${id}`, objectName: name, ra: 83.8, dec: -5.4, startTime: at(offsetHours), endTime: at(offsetHours + 1.5),
      notes: '', framingSetup: null, filterBand: null, filter: null, skipped: 0, outcome,
      createdAt: at(-30), updatedAt: at(-30), ...extra,
    };
  }

  async function mockSessions(page: Page, sessions: ReturnType<typeof session>[]) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    await page.route('**/api/planned-sessions**', async r => {
      const req = r.request();
      if (req.method() === 'GET') return r.fulfill(json(ok(sessions)));
      let body: unknown = null;
      try { body = req.postDataJSON(); } catch { /* no body */ }
      calls.push({ method: req.method(), path: new URL(req.url()).pathname, body });
      return r.fulfill(json(ok({ id: 99 })));
    });
    return calls;
  }

  const partial = { status: 'partial', plannedSec: 10800, achievedSec: 6000, frames: 40 };
  const missed = { status: 'missed', plannedSec: 5400, achievedSec: 0, frames: 0 };
  const awaiting = { status: 'awaiting_import', plannedSec: 5400, achievedSec: 0, frames: 0 };
  const skipped = { status: 'skipped', plannedSec: 5400, achievedSec: 0, frames: 0 };
  const done = { status: 'done', plannedSec: 5400, achievedSec: 5400, frames: 30 };

  test('a block shows what it produced against what was planned', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Partial Target', 0.5, partial)]);
    await page.goto('/planner');
    await expect(page.getByText('1h 40m / 3h')).toBeVisible();
  });

  test('a missed block says Missed, and a block waiting for the import says so instead', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Missed Target', 0.5, missed), session(2, 'Waiting Target', 2.5, awaiting)]);
    await page.goto('/planner');
    await expect(page.getByText('Missed', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for images', { exact: true })).toBeVisible();
  });

  test('a skipped block says Skipped', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Skipped Target', 0.5, skipped, { skipped: 1 })]);
    await page.goto('/planner');
    await expect(page.getByText('Skipped', { exact: true })).toBeVisible();
  });

  test('an upcoming block shows no outcome', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Later Target', 6, { status: 'upcoming', plannedSec: 5400, achievedSec: 0, frames: 0 })]);
    await page.goto('/planner');
    await expect(page.getByText('Later Target').first()).toBeVisible();
    await expect(page.getByText(/Missed|Skipped|Waiting for images|Partly done/)).toHaveCount(0);
  });

  test('a finished block offers neither follow-up', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Done Target', 0.5, done)]);
    await page.goto('/planner');
    await expect(page.getByText('1h 30m / 1h 30m')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Plan again the next night' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark as skipped' })).toHaveCount(0);
  });

  test('a block waiting for the import offers neither follow-up', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Waiting Target', 0.5, awaiting)]);
    await page.goto('/planner');
    await expect(page.getByText('Waiting for images', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Plan again the next night' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark as skipped' })).toHaveCount(0);
  });

  test('Plan again books the same clock times one day later', async ({ page }) => {
    await mockAllRoutes(page);
    const missedSession = session(1, 'Missed Target', 0.5, missed);
    const calls = await mockSessions(page, [missedSession]);
    await page.goto('/planner');
    await page.getByRole('button', { name: 'Plan again the next night' }).click();

    await expect.poll(() => calls.find(c => c.method === 'POST')?.body).toMatchObject({
      objectId: 'OBJ1', objectName: 'Missed Target',
      startTime: new Date(Date.parse(missedSession.startTime) + 86_400_000).toISOString(),
      endTime: new Date(Date.parse(missedSession.endTime) + 86_400_000).toISOString(),
    });
  });

  test('a partly done block can be planned again but not marked skipped', async ({ page }) => {
    await mockAllRoutes(page);
    await mockSessions(page, [session(1, 'Partial Target', 0.5, partial)]);
    await page.goto('/planner');
    await expect(page.getByRole('button', { name: 'Plan again the next night' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark as skipped' })).toHaveCount(0);
  });

  test('Mark as skipped saves the skip', async ({ page }) => {
    await mockAllRoutes(page);
    const calls = await mockSessions(page, [session(1, 'Missed Target', 0.5, missed)]);
    await page.goto('/planner');
    await page.getByRole('button', { name: 'Mark as skipped' }).click();
    await expect.poll(() => calls.find(c => c.method === 'PATCH')?.body).toEqual({ skipped: true });
  });

  test('a skipped block can be unmarked', async ({ page }) => {
    await mockAllRoutes(page);
    const calls = await mockSessions(page, [session(1, 'Skipped Target', 0.5, skipped, { skipped: 1 })]);
    await page.goto('/planner');
    await page.getByRole('button', { name: 'Unmark skipped' }).click();
    await expect.poll(() => calls.find(c => c.method === 'PATCH')?.body).toEqual({ skipped: false });
    // Not the same as planning it again.
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
});

// Keeps the shared mock reachable for the specs above if its shape is ever needed here.
void MOCK;
