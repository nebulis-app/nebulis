import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  getAllNotes,
  getNotesForObject,
  getNote,
  getNoteById,
  createNote,
  updateNote,
  deleteNote,
} from '../lib/notes.js';

const router = Router();

const NoteBodySchema = z.object({
  objectId: z.string().min(1),
  date: z.string().min(1),
  bortleClass: z.number().nullable().optional(),
  seeingRating: z.number().nullable().optional(),
  transparencyRating: z.number().nullable().optional(),
  moonPhase: z.string().nullable().optional(),
  moonIllumination: z.number().nullable().optional(),
  equipment: z.string().optional(),
  notes: z.string().optional(),
  rating: z.number().nullable().optional(),
  location: z.string().optional(),
});

const NoteUpdateBodySchema = NoteBodySchema.partial();

// List all notes
router.get('/', (_req: Request, res: Response) => {
  res.apiSuccess(getAllNotes());
});

// List notes for an object
router.get('/object/:objectId', (req: Request, res: Response) => {
  res.apiSuccess(getNotesForObject(String(req.params.objectId)));
});

// Get note for a specific object + date — returns null when no note exists yet
router.get('/object/:objectId/:date', (req: Request, res: Response) => {
  const note = getNote(String(req.params.objectId), String(req.params.date)) ?? null;
  res.apiSuccess(note);
});

// Create a note
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = NoteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { objectId, date } = parsed.data;

  // Check if note already exists
  const existing = getNote(objectId, date);
  if (existing) {
    // Update instead
    const updated = updateNote(existing.id, parsed.data);
    res.apiSuccess(updated);
    return;
  }

  const note = createNote(parsed.data);
  res.apiSuccess(note);
});

// Update a note
router.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = NoteUpdateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const updated = updateNote(String(req.params.id), parsed.data);
  if (updated) {
    res.apiSuccess(updated);
  } else {
    res.apiError(404, 'NOT_FOUND', 'Note not found');
  }
});

// Delete a note
router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const deleted = deleteNote(String(req.params.id));
  if (deleted) {
    res.apiSuccess({ deleted: true });
  } else {
    res.apiError(404, 'NOT_FOUND', 'Note not found');
  }
});

export { router as notesRouter };
