import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  GearError,
  clearChecks,
  createGear,
  createKit,
  deleteGear,
  deleteKit,
  getChecks,
  getGear,
  getKit,
  listGear,
  listKits,
  setCheck,
  setGearArchived,
  updateGear,
  updateKit,
} from '../lib/gear.js';
import { ItemCreateSchema, ItemPatchSchema, KitSchema, KitPatchSchema, CheckSchema } from '../lib/gearSchemas.js';

const router = Router();

/** Turn a library error into the API's envelope. Anything else is a bug and falls through to the server's handler. */
function fail(res: Response, err: unknown): void {
  if (err instanceof GearError) {
    res.apiError(err.code === 'NOT_FOUND' ? 404 : 422, err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', err.message);
    return;
  }
  throw err;
}

function invalid(res: Response, error: z.ZodError): void {
  res.apiError(422, 'VALIDATION_ERROR', error.issues[0]?.message ?? 'Invalid request body');
}

// ─── Kits (declared before /:id so "kits" is never read as a gear id) ───

// GET /api/v1/gear/kits
router.get('/kits', (_req: Request, res: Response) => {
  res.apiSuccess(listKits());
});

// POST /api/v1/gear/kits
router.post('/kits', requireAdmin, (req: Request, res: Response) => {
  const parsed = KitSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(createKit(parsed.data)); } catch (err) { fail(res, err); }
});

// PUT /api/v1/gear/kits/:id
router.put('/kits/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = KitPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(updateKit(String(req.params.id), parsed.data)); } catch (err) { fail(res, err); }
});

// DELETE /api/v1/gear/kits/:id
router.delete('/kits/:id', requireAdmin, (req: Request, res: Response) => {
  if (!deleteKit(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Kit not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// GET /api/v1/gear/kits/:id/checks?night=2026-10-08
router.get('/kits/:id/checks', (req: Request, res: Response) => {
  const id = String(req.params.id), night = String(req.query.night ?? '');
  if (!getKit(id)) {
    res.apiError(404, 'NOT_FOUND', 'Kit not found');
    return;
  }
  try { res.apiSuccess({ night, checked: getChecks(id, night) }); } catch (err) { fail(res, err); }
});

// PUT /api/v1/gear/kits/:id/checks?night=2026-10-08   { itemKey, checked }
router.put('/kits/:id/checks', requireAdmin, (req: Request, res: Response) => {
  const parsed = CheckSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const night = String(req.query.night ?? '');
  try { res.apiSuccess({ night, checked: setCheck(String(req.params.id), night, parsed.data.itemKey, parsed.data.checked) }); } catch (err) { fail(res, err); }
});

// DELETE /api/v1/gear/kits/:id/checks?night=2026-10-08   (untick everything for that night)
router.delete('/kits/:id/checks', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id), night = String(req.query.night ?? '');
  if (!getKit(id)) {
    res.apiError(404, 'NOT_FOUND', 'Kit not found');
    return;
  }
  try { clearChecks(id, night); res.apiSuccess({ night, checked: [] }); } catch (err) { fail(res, err); }
});

// ─── Gear ───────────────────────────────────────────────────────────

// GET /api/v1/gear?archived=1
router.get('/', (req: Request, res: Response) => {
  res.apiSuccess(listGear({ includeArchived: req.query.archived === '1' }));
});

// POST /api/v1/gear
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = ItemCreateSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(createGear(parsed.data)); } catch (err) { fail(res, err); }
});

// GET /api/v1/gear/:id
router.get('/:id', (req: Request, res: Response) => {
  const item = getGear(String(req.params.id));
  if (!item) {
    res.apiError(404, 'NOT_FOUND', 'Gear not found');
    return;
  }
  res.apiSuccess(item);
});

// PUT /api/v1/gear/:id
router.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = ItemPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(updateGear(String(req.params.id), parsed.data)); } catch (err) { fail(res, err); }
});

// POST /api/v1/gear/:id/archive   and   /unarchive
router.post('/:id/archive', requireAdmin, (req: Request, res: Response) => {
  try { res.apiSuccess(setGearArchived(String(req.params.id), true)); } catch (err) { fail(res, err); }
});
router.post('/:id/unarchive', requireAdmin, (req: Request, res: Response) => {
  try { res.apiSuccess(setGearArchived(String(req.params.id), false)); } catch (err) { fail(res, err); }
});

// DELETE /api/v1/gear/:id
router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  if (!deleteGear(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Gear not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

export { router as gearRouter };
