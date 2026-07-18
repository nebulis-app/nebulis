/**
 * Planned imaging sessions API for the planner timeline.
 *
 * GET    /api/v1/planned-sessions?from=ISO&to=ISO   List sessions overlapping window.
 * POST   /api/v1/planned-sessions                    Create a new scheduled block.
 * PATCH  /api/v1/planned-sessions/:id                Move / resize / edit notes.
 * DELETE /api/v1/planned-sessions/:id                Remove a block.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import * as PlannedSessions from '../lib/plannedSessions.js';

const router = Router();

const ListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const CreateBodySchema = z.object({
  objectId: z.string().min(1),
  objectName: z.string().min(1),
  ra: z.number(),
  dec: z.number(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  notes: z.string().optional(),
});

const UpdateBodySchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  notes: z.string().optional(),
});

router.get('/', (req: Request, res: Response) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid query parameters');
    return;
  }
  const { from, to } = parsed.data;
  const sessions = from && to ? PlannedSessions.getInRange(from, to) : PlannedSessions.getAll();
  res.apiSuccess(sessions);
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
