/**
 * Chunked, resumable uploads (admin only). See server/lib/library/chunkedUploads.ts
 * for the lifecycle and docs/CHUNKED_UPLOADS.md for a client walkthrough.
 *
 *   POST   /uploads                      start: { target, objectId, filename, size, sha256?, title?, notes?, software? }
 *   PUT    /uploads/:uploadId/chunks/:i  raw bytes, Content-Range: bytes start-end/total
 *   GET    /uploads/:uploadId            received ranges, to resume
 *   POST   /uploads/:uploadId/complete   checks, then the same record as the single POST
 *   DELETE /uploads/:uploadId            abort
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import {
  UPLOAD_TARGETS,
  UploadError,
  abortUpload,
  completeUpload,
  createUpload,
  uploadStatus,
  writeChunk,
} from '../lib/library/chunkedUploads.js';

const router = Router();

/**
 * Who may continue an upload: a fingerprint of the credential sent with the
 * request (Bearer token and X-API-Key together, as auth.ts reads them). Two
 * admins, or the same admin with two different keys, cannot touch each
 * other's uploads. Only the hash is kept, never the credential.
 */
export function uploadOwnerOf(req: Request): string {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const rawKey = req.headers['x-api-key'];
  const apiKey = typeof rawKey === 'string' ? rawKey : '';
  if (bearer || apiKey) {
    return `key:${createHash('sha256').update(`${bearer}\n${apiKey}`).digest('hex')}`;
  }
  return `user:${req.userId ?? ''}`;
}

function sendError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof UploadError) {
    res.apiError(err.status, err.code, err.message, err.details);
    return;
  }
  log.error({ err }, '[uploads] request failed');
  res.apiError(500, 'UPLOAD_FAILED', 'The upload failed on the server.');
}

const CreateUploadSchema = z.object({
  target: z.enum(UPLOAD_TARGETS),
  objectId: z.string().trim().min(1).max(200),
  filename: z.string().min(1).max(1024),
  size: z.number().int().positive(),
  sha256: z.string().optional(),
  title: z.string().max(10_000).optional(),
  notes: z.string().max(100_000).optional(),
  software: z.string().max(1_000).optional(),
});

router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = CreateUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.apiError(422, 'VALIDATION_ERROR', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request body');
    return;
  }
  try {
    res.apiSuccess(createUpload(parsed.data, uploadOwnerOf(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:uploadId', requireAdmin, (req: Request, res: Response) => {
  try {
    res.apiSuccess(uploadStatus(String(req.params.uploadId), uploadOwnerOf(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:uploadId/chunks/:index', requireAdmin, async (req: Request, res: Response) => {
  // Raw bytes only. A JSON or form body would already have been consumed by a
  // body parser, so the bytes would never reach the file.
  const type = req.headers['content-type'];
  if (type && !/^application\/octet-stream\b/i.test(type)) {
    res.set('Connection', 'close');
    res.apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send chunk bytes as application/octet-stream.');
    return;
  }
  try {
    const result = await writeChunk(
      String(req.params.uploadId),
      uploadOwnerOf(req),
      String(req.params.index),
      req.headers['content-range'],
      req.headers['content-length'],
      req,
    );
    res.apiSuccess(result);
  } catch (err) {
    // A refused chunk can leave unread bytes on the socket; do not reuse it.
    // (A body longer than its range is cut off mid-stream, so that client
    // sees the connection close rather than a JSON error. Content-Length,
    // checked first, catches the usual case with a proper 400.)
    if (!res.headersSent) res.set('Connection', 'close');
    sendError(res, err);
  }
});

router.post('/:uploadId/complete', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { record, sha256, size } = await completeUpload(String(req.params.uploadId), uploadOwnerOf(req));
    // `data` is the record the single-POST endpoint returns, unchanged.
    res.apiSuccess(record, { sha256, size });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:uploadId', requireAdmin, (req: Request, res: Response) => {
  const uploadId = String(req.params.uploadId);
  try {
    abortUpload(uploadId, uploadOwnerOf(req));
    res.apiSuccess({ aborted: true, uploadId });
  } catch (err) {
    sendError(res, err);
  }
});

export { router as uploadsRouter };
