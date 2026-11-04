// Request and response shapes for the journal routes. They live here so
// server/routes/openapi.ts generates the published spec from the schemas the
// handlers validate with (see telescopeSchemas.ts for the pattern).

import { z } from 'zod';
import { JOURNAL_LIMITS, type JournalAttachment, type JournalEntry } from './journal.js';

const night = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Nights look like 2026-10-08');
export const ChecklistSchema = z.array(z.object({ text: z.string().max(JOURNAL_LIMITS.checklistText), done: z.boolean() })).max(JOURNAL_LIMITS.checklistItems);

export const EntryCreateSchema = z.object({
  night,
  objectId: z.string().max(200).nullable().optional(),
  filePath: z.string().max(1000).nullable().optional(),
  title: z.string().max(JOURNAL_LIMITS.title).optional(),
  body: z.string().max(JOURNAL_LIMITS.body).optional(),
  checklist: ChecklistSchema.optional(),
});
export const EntryPatchSchema = EntryCreateSchema.partial();

// ─── Response shapes ─────────────────────────────────────────────────

export const JournalAttachmentResponseSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().describe('Bytes'),
  createdAt: z.string(),
});

export const JournalEntryResponseSchema = z.object({
  id: z.string(),
  night: z.string().describe('The observing night, YYYY-MM-DD'),
  objectId: z.string().nullable(),
  filePath: z.string().nullable().describe('Library-relative path of the one file this entry is about'),
  title: z.string(),
  body: z.string(),
  checklist: ChecklistSchema,
  attachments: z.array(JournalAttachmentResponseSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const entryFieldsDocumented: [Missing<JournalEntry, typeof JournalEntryResponseSchema>] extends [never] ? true : never = true;
const attachmentFieldsDocumented: [Missing<JournalAttachment, typeof JournalAttachmentResponseSchema>] extends [never] ? true : never = true;
void [entryFieldsDocumented, attachmentFieldsDocumented];
