/**
 * Request and response shapes for the night notes and per-object notes routes.
 * They live here so server/routes/openapi.ts can generate the published spec
 * from the schemas the handlers validate with.
 */
import { z } from 'zod';
import type { ObservationNote } from './notes.js';
import type { ObjectNote } from './objectNotes.js';

export const NoteBodySchema = z.object({
  objectId: z.string().min(1),
  date: z.string().min(1),
  bortleClass: z.number().nullable().optional(),
  seeingRating: z.number().nullable().optional().describe('1 to 5'),
  transparencyRating: z.number().nullable().optional().describe('1 to 5'),
  moonPhase: z.string().nullable().optional(),
  moonIllumination: z.number().nullable().optional().describe('0 to 100 percent'),
  equipment: z.string().optional(),
  notes: z.string().optional(),
  rating: z.number().nullable().optional().describe('1 to 5 personal rating'),
  location: z.string().optional(),
});

export const NoteUpdateBodySchema = NoteBodySchema.partial();

export const ObservationNoteSchema = z.object({
  id: z.string(),
  objectId: z.string(),
  date: z.string(),
  bortleClass: z.number().nullable(),
  seeingRating: z.number().nullable(),
  transparencyRating: z.number().nullable(),
  moonPhase: z.string().nullable(),
  moonIllumination: z.number().nullable(),
  equipment: z.string(),
  notes: z.string(),
  rating: z.number().nullable(),
  location: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ObjectNoteBodySchema = z.object({
  text: z.string().describe('Blank text clears the note'),
});

export const ObjectNoteSchema = z.object({
  objectId: z.string(),
  text: z.string(),
  updatedAt: z.string(),
});

// ─── Compile-time coverage checks ──────────────────────────────────────────

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const noteFieldsDocumented: [Missing<ObservationNote, typeof ObservationNoteSchema>] extends [never] ? true : never = true;
const objectNoteFieldsDocumented: [Missing<ObjectNote, typeof ObjectNoteSchema>] extends [never] ? true : never = true;
void [noteFieldsDocumented, objectNoteFieldsDocumented];
