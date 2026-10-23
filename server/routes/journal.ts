import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  JOURNAL_LIMITS,
  JournalError,
  addAttachment,
  createEntry,
  deleteAttachment,
  deleteEntry,
  getAttachmentFile,
  getEntry,
  isInlineType,
  listEntries,
  updateEntry,
} from '../lib/journal.js';
import { contentDispositionHeader } from '../lib/queryHelpers.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, `nebulis_journal_${randomUUID()}`),
  }),
  limits: { fileSize: JOURNAL_LIMITS.attachmentBytes, files: 1 },
});

const night = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Nights look like 2026-10-08');
const ChecklistSchema = z.array(z.object({ text: z.string().max(JOURNAL_LIMITS.checklistText), done: z.boolean() })).max(JOURNAL_LIMITS.checklistItems);

const EntryCreateSchema = z.object({
  night,
  objectId: z.string().max(200).nullable().optional(),
  filePath: z.string().max(1000).nullable().optional(),
  title: z.string().max(JOURNAL_LIMITS.title).optional(),
  body: z.string().max(JOURNAL_LIMITS.body).optional(),
  checklist: ChecklistSchema.optional(),
});
const EntryPatchSchema = EntryCreateSchema.partial();

function fail(res: Response, err: unknown): void {
  if (err instanceof JournalError) {
    res.apiError(err.code === 'NOT_FOUND' ? 404 : 422, err.code, err.message);
    return;
  }
  throw err;
}

function invalid(res: Response, error: z.ZodError): void {
  res.apiError(422, 'VALIDATION_ERROR', error.issues[0]?.message ?? 'Invalid request body');
}

const queryNight = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

// GET /api/v1/journal?night=&from=&to=&objectId=
router.get('/', (req: Request, res: Response) => {
  res.apiSuccess(listEntries({
    night: queryNight(req.query.night),
    from: queryNight(req.query.from),
    to: queryNight(req.query.to),
    objectId: typeof req.query.objectId === 'string' && req.query.objectId ? req.query.objectId : undefined,
    limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
  }));
});

// ─── Attachments (declared before /:id so "attachments" is never read as an entry id) ───

// GET /api/v1/journal/attachments/:id   The file itself. Pictures and PDFs show inline; anything else downloads.
router.get('/attachments/:id', (req: Request, res: Response) => {
  const found = getAttachmentFile(String(req.params.id));
  if (!found) {
    res.apiError(404, 'NOT_FOUND', 'Attachment not found');
    return;
  }
  const { attachment, filePath } = found;
  const inline = isInlineType(attachment.mimeType) && req.query.download !== '1';
  res.setHeader('Content-Type', inline ? attachment.mimeType : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDispositionHeader(inline ? 'inline' : 'attachment', attachment.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  // The data folder may sit under a dot-folder (a Docker volume, ~/.nebulis), which sendFile refuses by default.
  res.sendFile(filePath, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.apiError(404, 'NOT_FOUND', 'Attachment not found');
  });
});

// DELETE /api/v1/journal/attachments/:id
router.delete('/attachments/:id', requireAdmin, (req: Request, res: Response) => {
  if (!deleteAttachment(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Attachment not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// ─── Entries ────────────────────────────────────────────────────────

// POST /api/v1/journal
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = EntryCreateSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(createEntry(parsed.data)); } catch (err) { fail(res, err); }
});

// GET /api/v1/journal/:id
router.get('/:id', (req: Request, res: Response) => {
  const e = getEntry(String(req.params.id));
  if (!e) {
    res.apiError(404, 'NOT_FOUND', 'Entry not found');
    return;
  }
  res.apiSuccess(e);
});

// PUT /api/v1/journal/:id
router.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = EntryPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  try { res.apiSuccess(updateEntry(String(req.params.id), parsed.data)); } catch (err) { fail(res, err); }
});

// DELETE /api/v1/journal/:id   (and its files)
router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  if (!deleteEntry(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Entry not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// POST /api/v1/journal/:id/attachments   multipart, one file in the "file" field
router.post('/:id/attachments', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      res.apiError(tooBig ? 413 : 400, tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
        tooBig ? `Files can be up to ${JOURNAL_LIMITS.attachmentBytes / 1024 / 1024} MB` : 'The upload could not be read');
      return;
    }
    next();
  });
}, (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.apiError(400, 'VALIDATION_ERROR', 'No file was sent');
    return;
  }
  try {
    res.apiSuccess(addAttachment(String(req.params.id), {
      tempPath: file.path, fileName: file.originalname, mimeType: file.mimetype, size: file.size,
    }));
  } catch (err) { fail(res, err); }
});

export { router as journalRouter };
