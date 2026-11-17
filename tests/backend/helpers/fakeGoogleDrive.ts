import { createHash } from 'crypto';

/**
 * An in-memory Google Drive, behind a `fetch` function.
 *
 * It answers the OAuth token endpoints and the slice of Drive v3 the archive uses
 * (files.list with the query shapes the client builds, files.get, alt=media,
 * folder create, PATCH for trash and rename, and resumable uploads in chunks), so
 * the archive's Drive engine can be driven end to end without the network.
 *
 * Knobs for the failure paths: `corruptNextUploads` makes Drive report a wrong MD5
 * for the next N uploads, `failNextChunks` answers the next N chunk PUTs with a 503,
 * and `revoked` makes every token refresh answer `invalid_grant`.
 */

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  trashed: boolean;
  modifiedTime: string;
}

const FOLDER = 'application/vnd.google-apps.folder';

export class FakeGoogleDrive {
  files = new Map<string, FakeDriveFile>();
  uploads = 0;
  chunkPuts = 0;
  corruptNextUploads = 0;
  failNextChunks = 0;
  revoked = false;
  quota: { limit: number | null; usage: number } = { limit: null, usage: 0 };
  /** Device-flow answers, in order, for the token poll. */
  devicePollAnswers: Array<{ status: number; body: Record<string, unknown> }> = [];
  private nextId = 1;
  private clock = 0;
  private sessions = new Map<string, { fileId?: string; name: string; parents: string[]; size: number; received: Buffer }>();

  constructor() {
    this.files.set('root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], content: Buffer.alloc(0), trashed: false, modifiedTime: this.tick() });
  }

  private tick(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.clock++ * 1000).toISOString();
  }

  /** Every live file and folder, as a path below `rootName` at the top of My Drive. */
  tree(rootName: string): Map<string, FakeDriveFile> {
    const out = new Map<string, FakeDriveFile>();
    const root = [...this.files.values()].find(f => f.parents.includes('root') && f.name === rootName && !f.trashed);
    if (!root) return out;
    const walk = (id: string, prefix: string): void => {
      for (const f of this.files.values()) {
        if (f.trashed || !f.parents.includes(id)) continue;
        const rel = prefix ? `${prefix}/${f.name}` : f.name;
        out.set(rel, f);
        if (f.mimeType === FOLDER) walk(f.id, rel);
      }
    };
    walk(root.id, '');
    return out;
  }

  /** Put a file straight into Drive, as if another install had written it. */
  seed(parentId: string, name: string, content: string | Buffer, mimeType = 'application/octet-stream'): FakeDriveFile {
    const file: FakeDriveFile = {
      id: `f${this.nextId++}`,
      name,
      mimeType,
      parents: [parentId],
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      trashed: false,
      modifiedTime: this.tick(),
    };
    this.files.set(file.id, file);
    return file;
  }

  private meta(f: FakeDriveFile, corrupt = false): Record<string, unknown> {
    const out: Record<string, unknown> = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, trashed: f.trashed };
    if (f.mimeType !== FOLDER) {
      out.size = String(f.content.length);
      out.md5Checksum = corrupt ? '0'.repeat(32) : createHash('md5').update(f.content).digest('hex');
      out.sha256Checksum = createHash('sha256').update(f.content).digest('hex');
    }
    return out;
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private async bodyBuffer(init?: RequestInit): Promise<Buffer> {
    const body = init?.body;
    if (body === undefined || body === null) return Buffer.alloc(0);
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof URLSearchParams) return Buffer.from(body.toString());
    return Buffer.from(await new Response(body).arrayBuffer());
  }

  /** Parse the query shapes driveClient builds. */
  private matches(f: FakeDriveFile, q: string): boolean {
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    if (parent !== undefined && !f.parents.includes(parent)) return false;
    if (/trashed = false/.test(q) && f.trashed) return false;
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
    if (name !== undefined && f.name !== name) return false;
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
    if (mime !== undefined && f.mimeType !== mime) return false;
    return true;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();

    // ── OAuth ──
    if (url.host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams((await this.bodyBuffer(init)).toString());
      if (url.pathname === '/device/code') {
        return this.json({ device_code: 'dev-code', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
      }
      if (url.pathname === '/revoke') return this.json({});
      if (url.pathname === '/token') {
        if (form.get('grant_type') === 'refresh_token') {
          if (this.revoked) return this.json({ error: 'invalid_grant' }, 400);
          return this.json({ access_token: 'access-token', expires_in: 3600 });
        }
        const next = this.devicePollAnswers.shift() ?? { status: 428, body: { error: 'authorization_pending' } };
        return this.json(next.body, next.status);
      }
    }

    if (url.host === 'fake-upload.local') {
      return this.putChunk(url.pathname, init);
    }

    // ── Drive ──
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== 'Bearer access-token') return this.json({ error: { message: 'unauthorized' } }, 401);

    if (url.pathname === '/drive/v3/about') {
      return this.json({
        user: { emailAddress: 'astro@example.com' },
        storageQuota: { ...(this.quota.limit !== null ? { limit: String(this.quota.limit) } : {}), usage: String(this.quota.usage) },
      });
    }

    const uploadMatch = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (uploadMatch) {
      const meta: Record<string, unknown> = JSON.parse((await this.bodyBuffer(init)).toString() || '{}');
      const size = Number(new Headers(init?.headers).get('x-upload-content-length') ?? '0');
      const session = `/s${this.nextId++}`;
      this.sessions.set(session, {
        fileId: uploadMatch[1] ? decodeURIComponent(uploadMatch[1]) : undefined,
        name: String(meta.name ?? ''),
        parents: Array.isArray(meta.parents) ? meta.parents.map(String) : [],
        size,
        received: Buffer.alloc(0),
      });
      return new Response(null, { status: 200, headers: { Location: `https://fake-upload.local${session}` } });
    }

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const files = [...this.files.values()].filter(f => f.id !== 'root' && this.matches(f, q)).map(f => this.meta(f));
      return this.json({ files });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta: Record<string, unknown> = JSON.parse((await this.bodyBuffer(init)).toString());
      const parents = Array.isArray(meta.parents) ? meta.parents.map(String) : ['root'];
      const file = this.seed(parents[0], String(meta.name), Buffer.alloc(0), String(meta.mimeType));
      return this.json(this.meta(file));
    }
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      const file = this.files.get(decodeURIComponent(fileMatch[1]));
      if (!file) return this.json({ error: { message: 'File not found' } }, 404);
      if (method === 'PATCH') {
        const patch: Record<string, unknown> = JSON.parse((await this.bodyBuffer(init)).toString());
        if (patch.trashed === true) file.trashed = true;
        if (typeof patch.name === 'string') file.name = patch.name;
        file.modifiedTime = this.tick();
        return this.json(this.meta(file));
      }
      if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.content), { status: 200 });
      return this.json(this.meta(file));
    }
    return this.json({ error: { message: `unhandled ${method} ${url.pathname}` } }, 500);
  };

  private async putChunk(sessionPath: string, init?: RequestInit): Promise<Response> {
    const session = this.sessions.get(sessionPath);
    if (!session) return this.json({ error: { message: 'no session' } }, 404);
    const range = new Headers(init?.headers).get('content-range') ?? '';
    const body = await this.bodyBuffer(init);
    const status = /^bytes \*\/(\d+)$/.exec(range);
    if (status) {
      // A status query: say how much has arrived.
      if (session.received.length >= session.size && session.size > 0) return this.finish(sessionPath);
      return new Response(null, { status: 308, headers: session.received.length > 0 ? { Range: `bytes=0-${session.received.length - 1}` } : {} });
    }
    this.chunkPuts++;
    if (this.failNextChunks > 0) {
      this.failNextChunks--;
      return this.json({ error: { message: 'backend error' } }, 503);
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      if (start !== session.received.length) return this.json({ error: { message: 'bad offset' } }, 400);
      session.received = Buffer.concat([session.received, body]);
    } else {
      session.received = body;
    }
    if (session.received.length >= session.size) return this.finish(sessionPath);
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${session.received.length - 1}` } });
  }

  private finish(sessionPath: string): Response {
    const session = this.sessions.get(sessionPath);
    if (!session) return this.json({ error: { message: 'no session' } }, 404);
    this.sessions.delete(sessionPath);
    this.uploads++;
    let file: FakeDriveFile;
    if (session.fileId) {
      const existing = this.files.get(session.fileId);
      if (!existing) return this.json({ error: { message: 'File not found' } }, 404);
      existing.content = session.received;
      existing.modifiedTime = this.tick();
      file = existing;
    } else {
      file = this.seed(session.parents[0], session.name, session.received);
    }
    const corrupt = this.corruptNextUploads > 0;
    if (corrupt) this.corruptNextUploads--;
    return this.json(this.meta(file, corrupt));
  }
}
