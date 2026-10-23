/**
 * Journal: what the user writes about a night, on top of what the library already knows about it. A note, a packing list,
 * a screenshot of where the scope stood, a PDF of the club's site rules.
 *
 * Every entry belongs to a night (yyyy-MM-dd, the evening's date). It may also point at one object imaged that night, and at
 * one file of it, which is how a comment lands on a single picture. Nothing here copies library data: an entry only names the
 * object id and the file's library path, and the clients look both up.
 *
 * Attachments live on disk under DATA_DIR/journal/<entryId>/, named by their own id, never by the uploaded name, so a name
 * can't reach outside the folder. The original name is kept in the row for display and download.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import db from './db.js';
import { DATA_DIR } from './paths.js';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface JournalAttachment {
  id: string;
  entryId: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface JournalEntry {
  id: string;
  night: string;
  objectId: string | null;
  filePath: string | null;
  title: string;
  body: string;
  checklist: ChecklistItem[];
  attachments: JournalAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntryInput {
  night?: string;
  objectId?: string | null;
  filePath?: string | null;
  title?: string;
  body?: string;
  checklist?: ChecklistItem[];
}

export const JOURNAL_LIMITS = {
  title: 200,
  body: 20_000,
  checklistItems: 200,
  checklistText: 300,
  attachmentsPerEntry: 30,
  attachmentBytes: 100 * 1024 * 1024,
  fileName: 200,
} as const;

export class JournalError extends Error {
  constructor(public code: 'NOT_FOUND' | 'VALIDATION_ERROR', message: string) {
    super(message);
  }
}

export const JOURNAL_DIR = path.join(DATA_DIR, 'journal');

const NIGHT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Types a browser may show inline. Anything else is served as a download, so an uploaded page can never run as the app. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/tiff', 'application/pdf', 'text/plain']);

export function isInlineType(mime: string): boolean {
  return INLINE_TYPES.has(mime.toLowerCase());
}

interface EntryRow {
  id: string; night: string; objectId: string | null; filePath: string | null; title: string; body: string
  checklistJson: string; createdAt: string; updatedAt: string
}
interface AttachmentRow { id: string; entryId: string; fileName: string; mimeType: string; size: number; storedName: string; createdAt: string }

const stmts = {
  insert: db.prepare(`INSERT INTO journalEntries (id, night, objectId, filePath, title, body, checklistJson, createdAt, updatedAt)
                      VALUES (@id, @night, @objectId, @filePath, @title, @body, @checklistJson, @createdAt, @updatedAt)`),
  update: db.prepare(`UPDATE journalEntries SET night = @night, objectId = @objectId, filePath = @filePath, title = @title, body = @body,
                      checklistJson = @checklistJson, updatedAt = @updatedAt WHERE id = @id`),
  get: db.prepare<[string], EntryRow>('SELECT * FROM journalEntries WHERE id = ?'),
  delete: db.prepare('DELETE FROM journalEntries WHERE id = ?'),
  attachmentsFor: db.prepare<[string], AttachmentRow>('SELECT * FROM journalAttachments WHERE entryId = ? ORDER BY createdAt, id'),
  attachment: db.prepare<[string], AttachmentRow>('SELECT * FROM journalAttachments WHERE id = ?'),
  insertAttachment: db.prepare(`INSERT INTO journalAttachments (id, entryId, fileName, mimeType, size, storedName, createdAt)
                                VALUES (@id, @entryId, @fileName, @mimeType, @size, @storedName, @createdAt)`),
  deleteAttachment: db.prepare('DELETE FROM journalAttachments WHERE id = ?'),
  deleteAttachmentsFor: db.prepare('DELETE FROM journalAttachments WHERE entryId = ?'),
  countAttachments: db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM journalAttachments WHERE entryId = ?'),
  touch: db.prepare('UPDATE journalEntries SET updatedAt = ? WHERE id = ?'),
};

function attachment(r: AttachmentRow): JournalAttachment {
  return { id: r.id, entryId: r.entryId, fileName: r.fileName, mimeType: r.mimeType, size: r.size, createdAt: r.createdAt };
}

function parseChecklist(json: string): ChecklistItem[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => (x && typeof x === 'object' && typeof (x as ChecklistItem).text === 'string'
      ? [{ text: (x as ChecklistItem).text, done: (x as ChecklistItem).done === true }] : []));
  } catch {
    return [];
  }
}

function entry(r: EntryRow): JournalEntry {
  return {
    id: r.id, night: r.night, objectId: r.objectId, filePath: r.filePath, title: r.title, body: r.body,
    checklist: parseChecklist(r.checklistJson), attachments: stmts.attachmentsFor.all(r.id).map(attachment),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function cleanOptional(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function cleanChecklist(items: ChecklistItem[] | undefined): ChecklistItem[] {
  const out = (items ?? [])
    .map((i) => ({ text: String(i.text ?? '').trim().slice(0, JOURNAL_LIMITS.checklistText), done: i.done === true }))
    .filter((i) => i.text);
  if (out.length > JOURNAL_LIMITS.checklistItems) throw new JournalError('VALIDATION_ERROR', `A checklist holds at most ${JOURNAL_LIMITS.checklistItems} lines`);
  return out;
}

/** An entry has to say something: words, a list, or (once uploaded) a file. A brand-new empty one is allowed so files can follow. */
function clean(input: JournalEntryInput, base?: JournalEntry) {
  const night = input.night ?? base?.night ?? '';
  if (!NIGHT_RE.test(night)) throw new JournalError('VALIDATION_ERROR', 'Nights look like 2026-10-08');
  const objectId = input.objectId !== undefined ? cleanOptional(input.objectId, 200) : base?.objectId ?? null;
  let filePath = input.filePath !== undefined ? cleanOptional(input.filePath, 1000) : base?.filePath ?? null;
  // A picture is only ever commented on as part of an object's night.
  if (!objectId) filePath = null;
  if (filePath && (filePath.includes('\0') || filePath.split(/[\\/]/).includes('..'))) {
    throw new JournalError('VALIDATION_ERROR', 'That file path is not valid');
  }
  return {
    night,
    objectId,
    filePath,
    title: (input.title ?? base?.title ?? '').trim().slice(0, JOURNAL_LIMITS.title),
    body: (input.body ?? base?.body ?? '').slice(0, JOURNAL_LIMITS.body),
    checklist: input.checklist !== undefined ? cleanChecklist(input.checklist) : base?.checklist ?? [],
  };
}

export interface JournalQuery {
  night?: string;
  from?: string;
  to?: string;
  objectId?: string;
  limit?: number;
}

/** Newest night first; inside a night, oldest entry first so a conversation reads top to bottom. */
export function listEntries(q: JournalQuery = {}): JournalEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.night) { where.push('night = ?'); args.push(q.night); }
  if (q.from) { where.push('night >= ?'); args.push(q.from); }
  if (q.to) { where.push('night <= ?'); args.push(q.to); }
  if (q.objectId) { where.push('objectId = ?'); args.push(q.objectId); }
  const limit = Math.min(Math.max(q.limit ?? 1000, 1), 5000);
  const sql = `SELECT * FROM journalEntries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY night DESC, createdAt ASC, id LIMIT ${limit}`;
  return (db.prepare(sql).all(...args) as EntryRow[]).map(entry);
}

export function getEntry(id: string): JournalEntry | null {
  const r = stmts.get.get(id);
  return r ? entry(r) : null;
}

export function createEntry(input: JournalEntryInput, now = new Date()): JournalEntry {
  const c = clean(input);
  const stamp = now.toISOString();
  const id = randomUUID();
  stmts.insert.run({ id, ...c, checklistJson: JSON.stringify(c.checklist), createdAt: stamp, updatedAt: stamp });
  return getEntry(id) as JournalEntry;
}

export function updateEntry(id: string, input: JournalEntryInput, now = new Date()): JournalEntry {
  const existing = getEntry(id);
  if (!existing) throw new JournalError('NOT_FOUND', 'Entry not found');
  const c = clean(input, existing);
  stmts.update.run({ id, ...c, checklistJson: JSON.stringify(c.checklist), updatedAt: now.toISOString() });
  return getEntry(id) as JournalEntry;
}

export function deleteEntry(id: string): boolean {
  const removed = db.transaction(() => {
    stmts.deleteAttachmentsFor.run(id);
    return stmts.delete.run(id).changes > 0;
  })();
  if (removed) fs.rmSync(path.join(JOURNAL_DIR, id), { recursive: true, force: true });
  return removed;
}

/** Only a short, plain extension survives from the uploaded name; it is what lets Finder and Quick Look open a download. */
function safeExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/**
 * Moves an uploaded temp file into the entry's folder. The temp file is always consumed (moved or deleted), so a refused
 * upload never leaves anything behind.
 */
export function addAttachment(entryId: string, upload: { tempPath: string; fileName: string; mimeType: string; size: number }, now = new Date()): JournalAttachment {
  try {
    if (!stmts.get.get(entryId)) throw new JournalError('NOT_FOUND', 'Entry not found');
    if ((stmts.countAttachments.get(entryId)?.n ?? 0) >= JOURNAL_LIMITS.attachmentsPerEntry) {
      throw new JournalError('VALIDATION_ERROR', `An entry holds at most ${JOURNAL_LIMITS.attachmentsPerEntry} files`);
    }
    const id = randomUUID();
    const fileName = path.basename(upload.fileName.replace(/\\/g, '/')).replace(/\p{Cc}/gu, '').slice(0, JOURNAL_LIMITS.fileName) || 'file';
    const storedName = id + safeExtension(fileName);
    const dir = path.join(JOURNAL_DIR, entryId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, storedName);
    try {
      fs.renameSync(upload.tempPath, target);
    } catch {
      // A temp dir on another volume can't be renamed across; copy instead.
      fs.copyFileSync(upload.tempPath, target);
    }
    const row: AttachmentRow = {
      id, entryId, fileName, mimeType: (upload.mimeType || 'application/octet-stream').slice(0, 100), size: upload.size,
      storedName, createdAt: now.toISOString(),
    };
    stmts.insertAttachment.run(row);
    stmts.touch.run(row.createdAt, entryId);
    return attachment(row);
  } finally {
    fs.rmSync(upload.tempPath, { force: true });
  }
}

export function getAttachmentFile(id: string): { attachment: JournalAttachment; filePath: string } | null {
  const r = stmts.attachment.get(id);
  if (!r) return null;
  const filePath = path.join(JOURNAL_DIR, r.entryId, r.storedName);
  return fs.existsSync(filePath) ? { attachment: attachment(r), filePath } : null;
}

export function deleteAttachment(id: string, now = new Date()): boolean {
  const r = stmts.attachment.get(id);
  if (!r) return false;
  stmts.deleteAttachment.run(id);
  stmts.touch.run(now.toISOString(), r.entryId);
  fs.rmSync(path.join(JOURNAL_DIR, r.entryId, r.storedName), { force: true });
  return true;
}
