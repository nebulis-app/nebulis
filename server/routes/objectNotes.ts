import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { getObjectNote, saveObjectNote, deleteObjectNote } from '../lib/objectNotes.js';

const router = Router();

const MAX_LENGTH = 5000;
const BodySchema = z.object({ text: z.string() });

// null when the object has no note yet, like the per-night note lookup
router.get('/:objectId', (req: Request, res: Response) => {
  res.apiSuccess(getObjectNote(String(req.params.objectId)));
});

// Upsert. Blank text clears the note so clients can use one call for save and clear.
router.put('/:objectId', requireAdmin, (req: Request, res: Response) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const objectId = String(req.params.objectId);
  const text = parsed.data.text.trim();
  if (text.length > MAX_LENGTH) {
    res.apiError(422, 'VALIDATION_ERROR', `Note is limited to ${MAX_LENGTH} characters`);
    return;
  }
  if (!text) {
    deleteObjectNote(objectId);
    res.apiSuccess(null);
    return;
  }
  res.apiSuccess(saveObjectNote(objectId, text));
});

router.delete('/:objectId', requireAdmin, (req: Request, res: Response) => {
  deleteObjectNote(String(req.params.objectId));
  res.apiSuccess({ deleted: true });
});

export { router as objectNotesRouter };
