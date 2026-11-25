/**
 * A small Google Drive v3 client: just the calls the archive needs.
 *
 * Written against the REST API with `fetch` rather than pulling in `googleapis`,
 * which is a very large dependency for a dozen endpoints. Everything goes through
 * `request`, which adds the bearer token, retries what Google documents as
 * retryable (429, 5xx, and the 403 rate-limit reasons) with exponential backoff, and
 * gets a fresh token once on a 401.
 *
 * **Scope.** The archive asks for `drive.file` only, so this client can see and
 * change the files Nebulis itself created and nothing else in the user's Drive.
 * That is also why nothing here can reach outside the archive folder: Drive
 * itself refuses it.
 *
 * **Uploads** use the resumable protocol in chunks. An interrupted chunk is resumed
 * from the offset Drive reports rather than starting the file again, which matters
 * for multi-gigabyte stacks on a home uplink. A file is never visible in Drive until
 * its last byte has arrived, so there is no `.part` stage: the upload is atomic on
 * Google's side, and the caller still compares Drive's checksum with its own before
 * it records anything.
 */

import fs from 'fs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** The fields every file read asks for, so a listing can be compared without a
 *  second round trip per file. */
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,trashed';

/** Resumable chunks must be a multiple of 256 KiB. 32 MiB keeps the number of
 *  round trips low while bounding what one failed chunk costs to resend. */
export const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

const MAX_ATTEMPTS = 6;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Absent for folders and Google-native documents. */
  size?: number;
  md5Checksum?: string;
  sha256Checksum?: string;
  modifiedTime?: string;
}

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveClientOptions {
  /** Returns a valid access token, refreshing when needed. */
  getAccessToken: () => Promise<string>;
  /** Called on a 401 so the next `getAccessToken` refreshes instead of returning
   *  the cached token. */
  invalidateAccessToken?: () => void;
  fetch?: typeof fetch;
  /** Test seam: how long to wait before retry `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
  chunkBytes?: number;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A DriveFile from an API response, field by field. */
export function parseDriveFile(value: unknown): DriveFile | null {
  if (!isRecordLike(value)) return null;
  const { id, name, mimeType, size, md5Checksum, sha256Checksum, modifiedTime } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mimeType !== 'string') return null;
  const file: DriveFile = { id, name, mimeType };
  // Drive returns `size` as a decimal string (int64 in JSON).
  if (typeof size === 'string' && /^\d+$/.test(size)) file.size = Number(size);
  else if (typeof size === 'number' && Number.isFinite(size)) file.size = size;
  if (typeof md5Checksum === 'string') file.md5Checksum = md5Checksum;
  if (typeof sha256Checksum === 'string') file.sha256Checksum = sha256Checksum;
  if (typeof modifiedTime === 'string') file.modifiedTime = modifiedTime;
  return file;
}

/** Quote a value for a Drive search query (`name = '...'`). */
export function quoteDriveQuery(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The first `error.errors[].reason`, which is how Drive says *why* a 403 happened. */
async function errorReason(res: Response): Promise<{ message: string; reason?: string }> {
  try {
    const body: unknown = await res.json();
    if (isRecordLike(body) && isRecordLike(body.error)) {
      const err = body.error;
      const message = typeof err.message === 'string' ? err.message : `HTTP ${res.status}`;
      const first = Array.isArray(err.errors) ? err.errors[0] : undefined;
      const reason = isRecordLike(first) && typeof first.reason === 'string' ? first.reason : undefined;
      return { message, reason };
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return { message: `HTTP ${res.status} ${res.statusText}`.trim() };
}

const RETRYABLE_403 = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);

function isRetryable(status: number, reason?: string): boolean {
  return status === 429 || status >= 500 || (status === 403 && reason !== undefined && RETRYABLE_403.has(reason));
}

export class DriveClient {
  private readonly fetchImpl: typeof fetch;
  private readonly backoffMs: (attempt: number) => number;
  readonly chunkBytes: number;

  constructor(private readonly options: DriveClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.backoffMs = options.backoffMs ?? (attempt => Math.min(32_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250);
    this.chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  }

  /**
   * One API call with auth, retries and a single token refresh. `init.body` must be
   * replayable (a string or a Buffer); streamed bodies go through the upload path,
   * which has its own resume logic.
   */
  private async request(url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.options.getAccessToken();
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, headers });
      } catch (err) {
        // A dropped connection or DNS hiccup: retry like a 5xx.
        if (attempt >= MAX_ATTEMPTS) throw new DriveError(err instanceof Error ? err.message : String(err), 0);
        await sleep(this.backoffMs(attempt));
        continue;
      }
      if (res.ok || okStatuses.includes(res.status)) return res;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.options.invalidateAccessToken?.();
        continue;
      }
      const { message, reason } = await errorReason(res);
      if (isRetryable(res.status, reason) && attempt < MAX_ATTEMPTS) {
        await sleep(this.backoffMs(attempt));
        continue;
      }
      throw new DriveError(message, res.status, reason);
    }
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.request(url, init);
    return res.json();
  }

  /** The signed-in account and its quota. `limit` is absent for unlimited plans. */
  async about(): Promise<{ email: string; limit: number | null; usage: number }> {
    const body = await this.json(`${DRIVE_API}/about?fields=user(emailAddress),storageQuota(limit,usage)`);
    const user = isRecordLike(body) && isRecordLike(body.user) ? body.user : {};
    const quota = isRecordLike(body) && isRecordLike(body.storageQuota) ? body.storageQuota : {};
    const num = (v: unknown): number | null => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : null);
    return {
      email: typeof user.emailAddress === 'string' ? user.emailAddress : '',
      limit: num(quota.limit),
      usage: num(quota.usage) ?? 0,
    };
  }

  /** Metadata for one file, or null when it is gone or in the bin. */
  async getFile(fileId: string): Promise<DriveFile | null> {
    try {
      const body = await this.json(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`);
      if (isRecordLike(body) && body.trashed === true) return null;
      return parseDriveFile(body);
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return null;
      throw err;
    }
  }

  /** Every file and folder directly inside `folderId`, bin excluded. */
  async listChildren(folderId: string, extraQuery = ''): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    const q = `${quoteDriveQuery(folderId)} in parents and trashed = false${extraQuery ? ` and ${extraQuery}` : ''}`;
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = await this.json(`${DRIVE_API}/files?${params.toString()}`);
      if (isRecordLike(body) && Array.isArray(body.files)) {
        for (const raw of body.files) {
          const file = parseDriveFile(raw);
          if (file) out.push(file);
        }
      }
      pageToken = isRecordLike(body) && typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  /** The children of `parentId` named exactly `name`, oldest first, so callers that
   *  find duplicates (Drive allows them) always settle on the same one. */
  async findByName(parentId: string, name: string, folderOnly = false): Promise<DriveFile[]> {
    const extra = `name = ${quoteDriveQuery(name)}${folderOnly ? ` and mimeType = ${quoteDriveQuery(FOLDER_MIME)}` : ''}`;
    const files = await this.listChildren(parentId, extra);
    return files.sort((a, b) => (a.modifiedTime ?? '').localeCompare(b.modifiedTime ?? ''));
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const body = await this.json(`${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    const file = parseDriveFile(body);
    if (!file) throw new DriveError('Drive returned an unexpected answer when creating a folder', 0);
    return file;
  }

  /** Download a small file's content. Used for the marker and the manifest only. */
  async downloadText(fileId: string): Promise<string> {
    const res = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return res.text();
  }

  /** Move a file to the bin rather than deleting it outright, so a mistake is
   *  recoverable from Drive for 30 days. */
  async trash(fileId: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async rename(fileId: string, name: string): Promise<void> {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  /** Upload a small in-memory file (marker, manifest), replacing `existingId`'s content
   *  when given. */
  async uploadBuffer(parentId: string, name: string, content: Buffer, mimeType: string, existingId?: string): Promise<DriveFile> {
    return this.uploadResumable({ parentId, name, mimeType, existingId, size: content.length, read: async (start, end) => content.subarray(start, end) });
  }

  /** Upload a file from disk in resumable chunks, replacing `existingId`'s content
   *  when given. The source is read chunk by chunk, so a large file never sits in
   *  memory. `signal` is checked between chunks. `onRead` sees every chunk read from
   *  disk with its offset, so a caller can hash the file in the same read; a resumed
   *  upload may read a range again, which is why the offset comes along. */
  async uploadFile(
    parentId: string,
    name: string,
    sourcePath: string,
    size: number,
    existingId?: string,
    signal?: AbortSignal,
    onRead?: (start: number, chunk: Buffer) => void,
  ): Promise<DriveFile> {
    const handle = await fs.promises.open(sourcePath, 'r');
    try {
      return await this.uploadResumable({
        parentId,
        name,
        mimeType: 'application/octet-stream',
        existingId,
        size,
        signal,
        read: async (start, end) => {
          const buf = Buffer.alloc(end - start);
          let offset = 0;
          while (offset < buf.length) {
            const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset);
            if (bytesRead === 0) throw new Error('source file shrank during upload');
            offset += bytesRead;
          }
          onRead?.(start, buf);
          return buf;
        },
      });
    } finally {
      await handle.close();
    }
  }

  private async uploadResumable(args: {
    parentId: string;
    name: string;
    mimeType: string;
    existingId?: string;
    size: number;
    signal?: AbortSignal;
    read: (start: number, end: number) => Promise<Buffer>;
  }): Promise<DriveFile> {
    const { parentId, name, mimeType, existingId, size, signal, read } = args;

    // Start the session. Creating sends the parent; updating must not (a file's
    // parents are changed through addParents, never by the metadata body).
    const initUrl = existingId
      ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=resumable&fields=${FILE_FIELDS}`
      : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
    const init = await this.request(initUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(existingId ? { name } : { name, parents: [parentId] }),
    });
    const sessionUrl = init.headers.get('location');
    if (!sessionUrl) throw new DriveError('Drive did not open an upload session', init.status);

    // An empty file is a single empty PUT.
    if (size === 0) {
      const res = await this.request(sessionUrl, { method: 'PUT', headers: { 'Content-Length': '0' }, body: new Uint8Array(0) });
      return this.finishedUpload(res);
    }

    let offset = 0;
    let failures = 0;
    for (;;) {
      if (signal?.aborted) {
        // Abandon the session; Drive discards an incomplete upload on its own.
        throw new DriveError('upload cancelled', 0, 'cancelled');
      }
      const end = Math.min(offset + this.chunkBytes, size);
      const chunk = await read(offset, end);
      let res: Response;
      try {
        // The session URL is itself the credential, so chunks carry no bearer token.
        // `request` is not used here because a 308 is not an error and a retry must
        // resume from Drive's offset rather than resend the same bytes blindly.
        res = await this.fetchImpl(sessionUrl, {
          method: 'PUT',
          headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
          // Copied into a plain ArrayBuffer-backed array, which is what fetch's body
          // type accepts; one chunk at a time, so the copy is bounded.
          body: new Uint8Array(chunk),
        });
      } catch {
        res = new Response(null, { status: 599 });
      }

      if (res.status === 200 || res.status === 201) return this.finishedUpload(res);
      if (res.status === 308) {
        offset = nextOffset(res.headers.get('range'));
        failures = 0;
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        throw new DriveError('the upload session expired', res.status);
      }
      if (res.status !== 599 && !(res.status === 429 || res.status >= 500)) {
        const { message, reason } = await errorReason(res);
        throw new DriveError(message, res.status, reason);
      }
      if (++failures >= MAX_ATTEMPTS) throw new DriveError('upload kept failing', res.status);
      await sleep(this.backoffMs(failures));
      // Ask Drive how much it actually has before resending anything.
      offset = await this.queryUploadOffset(sessionUrl, size);
      if (offset >= size) {
        const done = await this.fetchImpl(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
        if (done.status === 200 || done.status === 201) return this.finishedUpload(done);
      }
    }
  }

  private async queryUploadOffset(sessionUrl: string, size: number): Promise<number> {
    try {
      const res = await this.fetchImpl(sessionUrl, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
      if (res.status === 200 || res.status === 201) return size;
      if (res.status === 308) return nextOffset(res.headers.get('range'));
    } catch {
      // Still unreachable: resend from the start of what we know nothing about.
    }
    return 0;
  }

  private async finishedUpload(res: Response): Promise<DriveFile> {
    const file = parseDriveFile(await res.json());
    if (!file) throw new DriveError('Drive returned an unexpected answer after an upload', res.status);
    return file;
  }
}

/** The byte to send next, from a 308's `Range: bytes=0-N` header. No header means
 *  Drive has nothing yet. */
export function nextOffset(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}
