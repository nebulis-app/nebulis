/**
 * Chunked, resumable uploads for files too large for one multipart POST.
 *
 * A processing archive (final XISF + TIFF + a PixInsight .pxiproject) is
 * routinely 3–4 GB. One request that size is fragile on any network, and some
 * clients cannot send it at all: macOS refuses a single socket send over about
 * 2 GiB (EINVAL), so the upload dies before the server sees a byte. Here the
 * client sends the file in parts of a size the server picks, can ask which
 * parts arrived, and resends only what is missing.
 *
 * Lifecycle (routes in server/routes/uploads.ts):
 *   createUpload    → an upload id, the chunk size and an expiry
 *   writeChunk      → one chunk streamed to its offset in a staging file
 *   uploadStatus    → the byte ranges received so far, to resume
 *   completeUpload  → size and sha256 checks, then the same record as the
 *                     single-POST endpoints (addProjectArchive / addProcessedImage)
 *   abortUpload     → drop the staging file
 *
 * State lives in memory and in a JSON sidecar next to the staging file, so an
 * upload survives a server restart. Uploads idle past the expiry are swept by
 * sweepExpiredUploads (scheduled from server/index.ts).
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DATA_DIR } from '../paths.js';
import { getLibraryDir } from '../libraryPath.js';
import { log } from '../logger.js';
import { checkFreeSpace } from './importStaging.js';
import { resolveContainedObjectDir } from './objects.js';
import { invalidateAllImagesCache } from './gallery.js';
import {
  addProjectArchive,
  isProjectArchiveName,
  projectArchiveMimeType,
  type ProjectArchiveRecord,
} from './projectArchives.js';
import {
  addProcessedImage,
  isRenderableProcessedName,
  isStoredOnlyProcessedName,
  processedImageMimeType,
  type ProcessedImageRecord,
} from './processed.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const UPLOAD_TARGETS = ['project-archive', 'processed-image'] as const;
export type UploadTarget = typeof UPLOAD_TARGETS[number];
export type UploadStatus = 'uploading' | 'completing' | 'complete';

/** Never hand out a chunk larger than this, whatever the configuration says. */
export const MAX_CHUNK_SIZE = GiB;
const MIN_CHUNK_SIZE = MiB;
const DEFAULT_CHUNK_SIZE = 64 * MiB;
const DEFAULT_TTL_HOURS = 24;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Defaults per target. Project archives keep the 20 GB the single POST has
 *  always allowed; images keep 2 GB. */
const DEFAULT_MAX_SIZE: Record<UploadTarget, number> = {
  'project-archive': 20 * GiB,
  'processed-image': 2 * GiB,
};
const MAX_SIZE_ENV: Record<UploadTarget, string> = {
  'project-archive': 'NEBULIS_MAX_PROJECT_ARCHIVE_BYTES',
  'processed-image': 'NEBULIS_MAX_PROCESSED_IMAGE_BYTES',
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Largest file a target accepts, by chunks or by the single POST. */
export function maxUploadBytes(target: UploadTarget): number {
  return Math.floor(envNumber(MAX_SIZE_ENV[target], DEFAULT_MAX_SIZE[target]));
}

export function uploadChunkSize(): number {
  const n = Math.floor(envNumber('NEBULIS_UPLOAD_CHUNK_BYTES', DEFAULT_CHUNK_SIZE));
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, n));
}

/** How long an upload may sit without a new chunk before it is swept. */
export function uploadTtlMs(): number {
  return envNumber('NEBULIS_UPLOAD_EXPIRY_HOURS', DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
}

/** Outside os.tmpdir(), which is often a small RAM-backed tmpfs in a
 *  container. Same reasoning as IMPORT_TMP_BASE. */
export const UPLOAD_STAGING_DIR = path.join(DATA_DIR, 'chunked-uploads');

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

interface UploadState {
  version: 1;
  uploadId: string;
  /** Fingerprint of the credential that created the upload. */
  owner: string;
  target: UploadTarget;
  objectId: string;
  filename: string;
  size: number;
  sha256: string | null;
  title: string;
  notes: string;
  software: string;
  chunkSize: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Chunk indices fully written, ascending. */
  received: number[];
  status: UploadStatus;
  /** Set once complete, so a retried complete returns the same record. */
  result?: { record: ProjectArchiveRecord | ProcessedImageRecord; sha256: string };
}

export interface CreateUploadInput {
  target: UploadTarget;
  objectId: string;
  filename: string;
  size: number;
  sha256?: string;
  title?: string;
  notes?: string;
  software?: string;
}

export interface ByteRange { start: number; end: number }

export interface UploadStatusView {
  uploadId: string;
  target: UploadTarget;
  objectId: string;
  filename: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  /** Inclusive byte ranges received, merged. */
  received: ByteRange[];
  receivedBytes: number;
  /** Chunk indices still to send. */
  missing: number[];
  status: UploadStatus;
  expiresAt: string;
}

const uploads = new Map<string, UploadState>();
/** Chunk indices being written right now, per upload. */
const inFlight = new Map<string, Set<number>>();
/** Uploads whose complete step is hashing or moving the file. */
const completing = new Set<string>();

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const partPath = (id: string) => path.join(UPLOAD_STAGING_DIR, `${id}.part`);
const statePath = (id: string) => path.join(UPLOAD_STAGING_DIR, `${id}.json`);

function persist(state: UploadState): void {
  fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
  const tmp = `${statePath(state.uploadId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath(state.uploadId));
}

function removeFiles(id: string): void {
  for (const p of [partPath(id), statePath(id), `${statePath(id)}.tmp`]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

function loadState(id: string): UploadState | null {
  if (!UPLOAD_ID_RE.test(id)) return null;
  const cached = uploads.get(id);
  if (cached) return cached;
  let state: UploadState;
  try {
    state = JSON.parse(fs.readFileSync(statePath(id), 'utf8')) as UploadState;
  } catch {
    return null;
  }
  if (state.version !== 1 || state.uploadId !== id) return null;
  // A restart during complete leaves 'completing' with nobody hashing.
  if (state.status === 'completing') state.status = 'uploading';
  uploads.set(id, state);
  return state;
}

let allStatesLoaded = false;

/** Bring uploads left over from before a restart into memory, so the
 *  free-space reservation in createUpload counts them too. */
function loadAllStatesOnce(): void {
  if (allStatesLoaded) return;
  allStatesLoaded = true;
  let names: string[] = [];
  try { names = fs.readdirSync(UPLOAD_STAGING_DIR); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (m) loadState(m[1]);
  }
}

function isExpired(state: UploadState, now = Date.now()): boolean {
  return Date.parse(state.expiresAt) <= now;
}

/** The upload, if it exists, has not expired and belongs to `owner`. A foreign
 *  upload answers exactly like a missing one, so ids cannot be probed. */
function getOwned(id: string, owner: string): UploadState {
  const state = loadState(id);
  if (!state || state.owner !== owner || (isExpired(state) && state.status !== 'completing' && !completing.has(id))) {
    throw new UploadError(404, 'UPLOAD_NOT_FOUND', 'No such upload, or it has expired.');
  }
  return state;
}

function chunkCountOf(state: Pick<UploadState, 'size' | 'chunkSize'>): number {
  return Math.ceil(state.size / state.chunkSize);
}

/** Inclusive byte range of chunk `index`. */
export function chunkRange(state: Pick<UploadState, 'size' | 'chunkSize'>, index: number): ByteRange {
  const start = index * state.chunkSize;
  const end = Math.min(state.size, start + state.chunkSize) - 1;
  return { start, end };
}

function receivedBytesOf(state: UploadState): number {
  return state.received.reduce((sum, i) => {
    const r = chunkRange(state, i);
    return sum + (r.end - r.start + 1);
  }, 0);
}

function view(state: UploadState): UploadStatusView {
  const count = chunkCountOf(state);
  const have = new Set(state.received);
  const received: ByteRange[] = [];
  for (const i of state.received) {
    const r = chunkRange(state, i);
    const last = received[received.length - 1];
    if (last && last.end + 1 === r.start) last.end = r.end;
    else received.push({ ...r });
  }
  const missing: number[] = [];
  for (let i = 0; i < count; i++) if (!have.has(i)) missing.push(i);
  return {
    uploadId: state.uploadId,
    target: state.target,
    objectId: state.objectId,
    filename: state.filename,
    size: state.size,
    chunkSize: state.chunkSize,
    chunkCount: count,
    received,
    receivedBytes: receivedBytesOf(state),
    missing,
    status: state.status,
    expiresAt: state.expiresAt,
  };
}

/** Strip any directory part a client sent with the name, and refuse names a
 *  filesystem cannot take. The name is only ever used as a hint for the final
 *  filename; the staging file is named by the upload id. */
export function sanitizeUploadFilename(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').trim();
  if (!base || base === '.' || base === '..' || base.includes('\0') || Buffer.byteLength(base) > 255) {
    throw new UploadError(422, 'INVALID_FILENAME', 'The file name is empty or not usable.');
  }
  return base;
}

export function targetAcceptsName(target: UploadTarget, name: string): boolean {
  return target === 'project-archive'
    ? isProjectArchiveName(name)
    : isRenderableProcessedName(name) || isStoredOnlyProcessedName(name);
}

const ACCEPTED_DESCRIPTION: Record<UploadTarget, string> = {
  'project-archive': '.zip, .xpsm or .pxiproject',
  'processed-image': 'a processed image format (JPG, PNG, WebP, TIFF, XISF, FITS…)',
};

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function createUpload(input: CreateUploadInput, owner: string): {
  uploadId: string; chunkSize: number; chunkCount: number; maxSize: number; expiresAt: string;
} {
  const filename = sanitizeUploadFilename(input.filename);
  if (!targetAcceptsName(input.target, filename)) {
    throw new UploadError(415, 'UNSUPPORTED_FILE_TYPE', `This upload only accepts ${ACCEPTED_DESCRIPTION[input.target]}.`);
  }
  const maxSize = maxUploadBytes(input.target);
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new UploadError(422, 'INVALID_SIZE', 'size must be a positive whole number of bytes.');
  }
  if (input.size > maxSize) {
    throw new UploadError(413, 'FILE_TOO_LARGE', `This file is ${formatGb(input.size)}; the limit is ${formatGb(maxSize)}.`, { maxSize });
  }
  const sha256 = input.sha256 ? input.sha256.toLowerCase() : null;
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new UploadError(422, 'INVALID_SHA256', 'sha256 must be 64 hexadecimal characters.');
  }
  const subdir = input.target === 'project-archive' ? 'project-archives' : 'processed';
  if (!resolveContainedObjectDir(input.objectId, subdir)) {
    throw new UploadError(422, 'INVALID_OBJECT', 'This object id does not resolve to a library folder.');
  }

  fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
  loadAllStatesOnce();
  // Bytes other live uploads have still to write here, so two large uploads
  // started together cannot both pass the check and then run out of room.
  let outstanding = 0;
  for (const other of uploads.values()) {
    if (other.status === 'uploading' && !isExpired(other)) outstanding += other.size - receivedBytesOf(other);
  }
  const staging = checkFreeSpace(UPLOAD_STAGING_DIR, input.size + outstanding, 'to stage this upload');
  if (!staging.ok) {
    throw new UploadError(507, 'INSUFFICIENT_STORAGE', staging.message ?? 'Not enough free space to stage this upload.',
      { requiredBytes: staging.requiredBytes, freeBytes: staging.freeBytes });
  }
  const library = checkFreeSpace(getLibraryDir(), input.size, 'to store this file');
  if (!library.ok) {
    throw new UploadError(507, 'INSUFFICIENT_STORAGE', library.message ?? 'Not enough free space in your library to store this file.',
      { requiredBytes: library.requiredBytes, freeBytes: library.freeBytes });
  }

  const uploadId = randomUUID();
  const now = new Date();
  const state: UploadState = {
    version: 1,
    uploadId,
    owner,
    target: input.target,
    objectId: input.objectId,
    filename,
    size: input.size,
    sha256,
    title: input.title?.trim() ?? '',
    notes: input.notes?.trim() ?? '',
    software: input.software?.trim() ?? '',
    chunkSize: uploadChunkSize(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + uploadTtlMs()).toISOString(),
    received: [],
    status: 'uploading',
  };
  fs.writeFileSync(partPath(uploadId), '');
  persist(state);
  uploads.set(uploadId, state);
  log.info({ uploadId, target: state.target, objectId: state.objectId, size: state.size, chunkSize: state.chunkSize }, '[uploads] started');
  return { uploadId, chunkSize: state.chunkSize, chunkCount: chunkCountOf(state), maxSize, expiresAt: state.expiresAt };
}

export function uploadStatus(id: string, owner: string): UploadStatusView {
  return view(getOwned(id, owner));
}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/**
 * Stream one chunk to its offset in the staging file. Nothing is buffered
 * beyond the stream's own high-water mark, whatever the chunk size.
 *
 * Idempotent: a chunk sent again overwrites the same bytes. The chunk counts
 * as received only once every one of its bytes is on disk, so a connection
 * dropped mid-chunk leaves it in `missing` for the client to resend.
 */
export async function writeChunk(
  id: string,
  owner: string,
  indexParam: string,
  contentRange: string | undefined,
  contentLength: string | undefined,
  body: Readable,
): Promise<UploadStatusView & { chunk: { index: number; start: number; end: number; sha256: string } }> {
  const state = getOwned(id, owner);
  if (state.status !== 'uploading' || completing.has(id)) {
    throw new UploadError(409, 'UPLOAD_NOT_ACTIVE', 'This upload is completing or complete; it takes no more chunks.');
  }
  const count = chunkCountOf(state);
  const index = /^\d+$/.test(indexParam) ? Number(indexParam) : NaN;
  if (!Number.isSafeInteger(index) || index >= count) {
    throw new UploadError(400, 'INVALID_CHUNK_INDEX', `Chunk index must be 0 to ${count - 1}.`, { chunkCount: count });
  }
  const { start, end } = chunkRange(state, index);
  const length = end - start + 1;
  const range = contentRange ? CONTENT_RANGE_RE.exec(contentRange.trim()) : null;
  if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== state.size) {
    throw new UploadError(416, 'INVALID_RANGE', `Chunk ${index} must be sent with Content-Range: bytes ${start}-${end}/${state.size}.`,
      { expected: `bytes ${start}-${end}/${state.size}` });
  }
  if (contentLength !== undefined && Number(contentLength) !== length) {
    throw new UploadError(400, 'INVALID_LENGTH', `Chunk ${index} is ${length} bytes; Content-Length says ${contentLength}.`);
  }

  let busy = inFlight.get(id);
  if (!busy) { busy = new Set(); inFlight.set(id, busy); }
  if (busy.has(index)) {
    throw new UploadError(409, 'CHUNK_IN_PROGRESS', `Chunk ${index} is already being written.`);
  }
  busy.add(index);

  try {
    // Overwriting a chunk makes it partial until the write finishes.
    if (state.received.includes(index)) {
      state.received = state.received.filter(i => i !== index);
      persist(state);
    }

    const hash = createHash('sha256');
    let written = 0;
    const guard = new Transform({
      transform(piece: Buffer, _enc, cb) {
        written += piece.length;
        if (written > length) {
          cb(new UploadError(413, 'CHUNK_TOO_LARGE', `Chunk ${index} is longer than ${length} bytes.`));
          return;
        }
        hash.update(piece);
        cb(null, piece);
      },
    });
    try {
      await pipeline(body, guard, fs.createWriteStream(partPath(id), { flags: 'r+', start }));
    } catch (err) {
      if (err instanceof UploadError) throw err;
      log.warn({ uploadId: id, index, written, length, err }, '[uploads] chunk write interrupted');
      throw new UploadError(400, 'CHUNK_INCOMPLETE', `Chunk ${index} did not arrive in full; send it again.`);
    }
    if (written !== length) {
      throw new UploadError(400, 'CHUNK_INCOMPLETE', `Chunk ${index} had ${written} of ${length} bytes; send it again.`);
    }

    // The upload may have been aborted or swept while the bytes streamed.
    if (uploads.get(id) !== state || state.status !== 'uploading') {
      throw new UploadError(404, 'UPLOAD_NOT_FOUND', 'No such upload, or it has expired.');
    }
    if (!state.received.includes(index)) {
      state.received = [...state.received, index].sort((a, b) => a - b);
    }
    const now = Date.now();
    state.updatedAt = new Date(now).toISOString();
    state.expiresAt = new Date(now + uploadTtlMs()).toISOString();
    persist(state);
    return { ...view(state), chunk: { index, start, end, sha256: hash.digest('hex') } };
  } finally {
    busy.delete(index);
    if (busy.size === 0) inFlight.delete(id);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Check the assembled file and file it like the single-POST endpoint for the
 * target would. Returns that endpoint's record unchanged, plus the sha256
 * computed here. Retrying after success returns the same record.
 */
export async function completeUpload(id: string, owner: string): Promise<{
  record: ProjectArchiveRecord | ProcessedImageRecord; sha256: string; size: number;
}> {
  const state = getOwned(id, owner);
  if (state.status === 'complete' && state.result) {
    return { ...state.result, size: state.size };
  }
  if (completing.has(id) || state.status !== 'uploading') {
    throw new UploadError(409, 'UPLOAD_COMPLETING', 'This upload is already being completed.');
  }
  if ((inFlight.get(id)?.size ?? 0) > 0) {
    throw new UploadError(409, 'CHUNK_IN_PROGRESS', 'Chunks are still being written; complete once they finish.');
  }
  const { missing } = view(state);
  if (missing.length > 0) {
    throw new UploadError(409, 'UPLOAD_INCOMPLETE', `${missing.length} chunk(s) still to send.`, { missing });
  }

  completing.add(id);
  state.status = 'completing';
  persist(state);
  try {
    let onDisk: number;
    try {
      onDisk = fs.statSync(partPath(id)).size;
    } catch {
      throw new UploadError(410, 'UPLOAD_LOST', 'The staged file is gone; start the upload again.');
    }
    if (onDisk !== state.size) {
      throw new UploadError(422, 'SIZE_MISMATCH', `Received ${onDisk} bytes; the upload declared ${state.size}.`, { received: onDisk, size: state.size });
    }
    const sha256 = await sha256File(partPath(id));
    if (state.sha256 && sha256 !== state.sha256) {
      throw new UploadError(422, 'CHECKSUM_MISMATCH', 'The file received does not match the sha256 given at the start.',
        { expected: state.sha256, actual: sha256 });
    }

    const record = state.target === 'project-archive'
      ? addProjectArchive(state.objectId, partPath(id), state.filename, projectArchiveMimeType(state.filename),
        state.title, state.notes, state.software)
      : addProcessedImage(state.objectId, null, partPath(id), state.filename, processedImageMimeType(state.filename),
        state.title, state.notes, null);
    if (state.target === 'processed-image') invalidateAllImagesCache();

    state.status = 'complete';
    state.result = { record, sha256 };
    state.updatedAt = new Date().toISOString();
    persist(state);
    log.info({ uploadId: id, target: state.target, objectId: state.objectId, size: state.size, sha256 }, '[uploads] complete');
    return { record, sha256, size: state.size };
  } catch (err) {
    if (state.status === 'completing') {
      state.status = 'uploading';
      persist(state);
    }
    throw err;
  } finally {
    completing.delete(id);
  }
}

export function abortUpload(id: string, owner: string): void {
  getOwned(id, owner);
  if (completing.has(id)) {
    throw new UploadError(409, 'UPLOAD_COMPLETING', 'This upload is being completed and can no longer be aborted.');
  }
  uploads.delete(id);
  removeFiles(id);
  log.info({ uploadId: id }, '[uploads] aborted');
}

/**
 * Remove uploads idle past their expiry, plus staging files no state file
 * claims (a crash between the two writes). Returns how many uploads went.
 */
export function sweepExpiredUploads(now = Date.now()): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(UPLOAD_STAGING_DIR);
  } catch {
    return 0;
  }
  let swept = 0;
  const ids = new Set<string>();
  for (const name of entries) {
    const m = /^([0-9a-f-]{36})\.(part|json)$/.exec(name);
    if (m) ids.add(m[1]);
  }
  for (const id of ids) {
    if (completing.has(id) || inFlight.has(id)) continue;
    const state = loadState(id);
    if (state) {
      if (!isExpired(state, now)) continue;
    } else {
      // Orphan: judge by the file's own age.
      try {
        if (now - fs.statSync(partPath(id)).mtimeMs < uploadTtlMs()) continue;
      } catch { /* no part file either: just clean up */ }
    }
    uploads.delete(id);
    removeFiles(id);
    swept++;
  }
  if (swept > 0) log.info({ swept }, '[uploads] expired uploads removed');
  return swept;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startUploadExpiryScheduler(): void {
  stopUploadExpiryScheduler();
  const run = () => {
    try { sweepExpiredUploads(); } catch (err) { log.warn({ err }, '[uploads] expiry sweep failed'); }
  };
  sweepTimer = setInterval(run, Math.min(SWEEP_INTERVAL_MS, uploadTtlMs()));
  sweepTimer.unref();
  setTimeout(run, 30_000).unref();
}

export function stopUploadExpiryScheduler(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test hook: forget in-memory state so the next call reloads from disk. */
export function _resetUploadCacheForTests(): void {
  uploads.clear();
  allStatesLoaded = false;
}
