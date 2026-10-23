/**
 * Planned imaging sessions API for the planner timeline.
 *
 * GET    /api/v1/planned-sessions?from=ISO&to=ISO   List sessions overlapping window.
 * POST   /api/v1/planned-sessions                    Create a new scheduled block.
 * PATCH  /api/v1/planned-sessions/:id                Move / resize / edit notes / filter band.
 * DELETE /api/v1/planned-sessions/:id                Remove a block.
 *
 * GET    /api/v1/planned-sessions/nights?from=YYYY-MM-DD&to=YYYY-MM-DD
 *        Plan vs actual per object and observing night (Observations page).
 *
 * Every listed session carries an `outcome` (plan vs actual, computed from the
 * library on read — see server/lib/planOutcome.ts). Add `?outcomes=0` to skip
 * that work when only the schedule is needed.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import * as PlannedSessions from '../lib/plannedSessions.js';
import { computePlanOutcomes, summarizePlanByNight, type PlanOutcome } from '../lib/planOutcome.js';
import { getActiveSite } from '../lib/observingSites.js';
import { lookupTimeZoneForCoordinates } from '../lib/observerTimezone.js';
import { timeZoneOrLocal } from '../lib/timezone.js';
import { log } from '../lib/logger.js';

const router = Router();

const ListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  outcomes: z.enum(['0', '1']).optional(),
});



/** Observer time zone for nights and capture times: the active site's. */
function observerTimeZone(): string {
  const site = getActiveSite();
  const looked = site.latitude != null && site.longitude != null
    ? lookupTimeZoneForCoordinates(site.latitude, site.longitude)
    : null;
  return looked ?? timeZoneOrLocal(site.timezone);
}

const DAY_MS = 86_400_000;

/**
 * Sessions with their outcome attached. Outcomes are computed over the window
 * widened by a day on each side, so a night cut by the requested range still
 * sees all of its blocks (that decides whether subs are split by time).
 * Best-effort: a library error yields `outcome: null`, never a failed list.
 */
function withOutcomes(
  sessions: PlannedSessions.PlannedSession[],
  range: { from: string; to: string } | null,
): (PlannedSessions.PlannedSession & { outcome: PlanOutcome | null })[] {
  if (sessions.length === 0) return [];
  let outcomes = new Map<number, PlanOutcome>();
  try {
    const context = range
      ? PlannedSessions.getInRange(
        new Date(Date.parse(range.from) - DAY_MS).toISOString(),
        new Date(Date.parse(range.to) + DAY_MS).toISOString(),
      )
      : sessions;
    outcomes = computePlanOutcomes(context, {
      timeZone: observerTimeZone(),
      skippedIds: new Set(context.filter(s => s.skipped).map(s => s.id)),
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[planned-sessions] could not compute outcomes');
  }
  return sessions.map(s => ({ ...s, outcome: outcomes.get(s.id) ?? null }));
}


const CreateBodySchema = z.object({
  objectId: z.string().min(1),
  objectName: z.string().min(1),
  ra: z.number(),
  dec: z.number(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  notes: z.string().optional(),
  filterBand: z.enum(['broadband', 'narrowband']).nullable().optional(),
  filter: z.string().max(64).nullable().optional(),
});

const UpdateBodySchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  notes: z.string().optional(),
  framingSetup: z.string().optional(),
  // null clears it.
  filterBand: z.enum(['broadband', 'narrowband']).nullable().optional(),
  filter: z.string().max(64).nullable().optional(),
  /** Mark a block as deliberately skipped (or clear the mark). */
  skipped: z.boolean().optional(),
});

router.get('/', (req: Request, res: Response) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { from, to, outcomes } = parsed.data;
  const range = from && to ? { from, to } : null;
  const sessions = range ? PlannedSessions.getInRange(range.from, range.to) : PlannedSessions.getAll();
  res.apiSuccess(outcomes === '0' ? sessions : withOutcomes(sessions, range));
});

const NightsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Declared before '/:id' routes; the path is static so there is no clash.
router.get('/nights', (req: Request, res: Response) => {
  const parsed = NightsQuerySchema.safeParse(req.query);
  if (!parsed.success || parsed.data.to < parsed.data.from) {
    res.apiError(422, 'VALIDATION_ERROR', 'from and to must be YYYY-MM-DD dates, from <= to');
    return;
  }
  const { from, to } = parsed.data;
  const timeZone = observerTimeZone();
  // Nights run noon to noon locally, so pad the instant window by a day on
  // each side and keep only the summaries whose night falls in [from, to].
  const sessions = PlannedSessions.getInRange(
    new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString(),
    new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString(),
  );
  try {
    const outcomes = computePlanOutcomes(sessions, {
      timeZone,
      skippedIds: new Set(sessions.filter(s => s.skipped).map(s => s.id)),
    });
    res.apiSuccess(summarizePlanByNight(sessions, outcomes, timeZone).filter(n => n.night >= from && n.night <= to));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute plan outcomes';
    res.apiError(500, 'PLAN_OUTCOME_FAILED', message);
  }
});

router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = CreateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  // Reject zero-length or inverted ranges. The UI snaps to a 10-minute grid
  // so this only catches programmatic / accidental zero-duration drops.
  if (new Date(parsed.data.endTime).getTime() <= new Date(parsed.data.startTime).getTime()) {
    res.apiError(422, 'VALIDATION_ERROR', 'endTime must be after startTime');
    return;
  }
  res.apiSuccess(PlannedSessions.create(parsed.data));
});

router.patch('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.apiError(422, 'VALIDATION_ERROR', 'Invalid session id');
    return;
  }
  const parsed = UpdateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const existing = PlannedSessions.getById(id);
  if (!existing) {
    res.apiError(404, 'NOT_FOUND', 'Planned session not found');
    return;
  }
  const mergedStart = parsed.data.startTime ?? existing.startTime;
  const mergedEnd = parsed.data.endTime ?? existing.endTime;
  if (new Date(mergedEnd).getTime() <= new Date(mergedStart).getTime()) {
    res.apiError(422, 'VALIDATION_ERROR', 'endTime must be after startTime');
    return;
  }
  const updated = PlannedSessions.update(id, parsed.data);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Planned session not found');
    return;
  }
  res.apiSuccess(updated);
});

router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.apiError(422, 'VALIDATION_ERROR', 'Invalid session id');
    return;
  }
  const deleted = PlannedSessions.remove(id);
  if (!deleted) {
    res.apiError(404, 'NOT_FOUND', 'Planned session not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

export { router as plannedSessionsRouter };
