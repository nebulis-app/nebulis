import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import * as Wishlist from '../lib/wishlist.js';

const router = Router();

const WishlistPostBodySchema = z.object({
  objectId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  constellation: z.string().optional(),
  magnitude: z.number().optional(),
  majorAxisArcmin: z.number().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  notes: z.string().default(''),
});

const WishlistPatchBodySchema = z.object({
  priority: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().optional(),
});

// GET /api/v1/wishlist
router.get('/', (_req: Request, res: Response) => {
  res.apiSuccess(Wishlist.getAll());
});

// POST /api/v1/wishlist
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = WishlistPostBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { objectId, name, type, constellation, magnitude, majorAxisArcmin, priority, notes } = parsed.data;

  const item = Wishlist.add({
    objectId,
    name,
    type: type ?? '',
    constellation: constellation ?? null,
    magnitude: magnitude ?? null,
    majorAxisArcmin: majorAxisArcmin ?? null,
    priority,
    notes,
  });

  res.apiSuccess(item);
});

// PATCH /api/v1/wishlist/:id
router.patch('/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = WishlistPatchBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { priority, notes } = parsed.data;
  const updated = Wishlist.update(String(req.params.id), { priority, notes });
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Wishlist item not found');
    return;
  }
  res.apiSuccess(updated);
});

// DELETE /api/v1/wishlist/:id
router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const deleted = Wishlist.remove(String(req.params.id));
  if (!deleted) {
    res.apiError(404, 'NOT_FOUND', 'Wishlist item not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// DELETE /api/v1/wishlist/object/:objectId  (remove by catalog ID)
router.delete('/object/:objectId', requireAdmin, (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const deleted = Wishlist.removeByObjectId(objectId);
  res.apiSuccess({ deleted });
});

export { router as wishlistRouter };
