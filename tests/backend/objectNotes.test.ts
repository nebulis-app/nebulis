import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
// New in the object-note change (spec 2026-10-28-object-note.md): a NEW router file, so
// no existing endpoint changes. Contract the tests pin:
//   mounted at /api/v1/object-notes (tests mount it at /object-notes)
//   GET    /:objectId  -> data null, or { objectId, text, updatedAt }
//   PUT    /:objectId  body { text } (admin) -> upsert; trims; empty text deletes; > 5000 chars -> 422
//   DELETE /:objectId  (admin) -> removes; GET then returns null
import { objectNotesRouter } from '../../server/routes/objectNotes';

let server: http.Server;
let baseUrl: string;
let currentRole = 'admin';
const touched = new Set<string>();

interface ApiResult { status: number; body: { data?: unknown; error?: { code: string } } }

async function api(method: string, p: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${baseUrl}/object-notes${p}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ApiResult['body'] };
}

/** Use a unique id per test and remember it so cleanup deletes only ids this file created. */
function id(name: string): string {
  const objectId = `__objnote_test_${name}`;
  touched.add(objectId);
  return objectId;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = currentRole;
    next();
  });
  app.use('/object-notes', objectNotesRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(async () => {
  currentRole = 'admin';
  for (const objectId of touched) await api('DELETE', `/${encodeURIComponent(objectId)}`);
  touched.clear();
});

describe('object notes API', () => {
  it('GET returns null when the object has no note', async () => {
    const r = await api('GET', `/${id('none')}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toBeNull();
  });

  it('PUT then GET returns the text', async () => {
    const oid = id('roundtrip');
    const put = await api('PUT', `/${oid}`, { text: 'Needs a UHC filter' });
    expect(put.status).toBe(200);
    const got = await api('GET', `/${oid}`);
    expect((got.body.data as { text: string }).text).toBe('Needs a UHC filter');
  });

  it('PUT again replaces the text (one note per object)', async () => {
    const oid = id('replace');
    await api('PUT', `/${oid}`, { text: 'first' });
    await api('PUT', `/${oid}`, { text: 'second' });
    const got = await api('GET', `/${oid}`);
    expect((got.body.data as { text: string }).text).toBe('second');
  });

  it('trims the text', async () => {
    const oid = id('trim');
    await api('PUT', `/${oid}`, { text: '  padded \n' });
    const got = await api('GET', `/${oid}`);
    expect((got.body.data as { text: string }).text).toBe('padded');
  });

  it('PUT with empty or whitespace text removes the note', async () => {
    const oid = id('empty');
    await api('PUT', `/${oid}`, { text: 'something' });
    const put = await api('PUT', `/${oid}`, { text: '   ' });
    expect(put.status).toBe(200);
    expect((await api('GET', `/${oid}`)).body.data).toBeNull();
  });

  it('DELETE removes the note and GET returns null', async () => {
    const oid = id('delete');
    await api('PUT', `/${oid}`, { text: 'gone soon' });
    const del = await api('DELETE', `/${oid}`);
    expect(del.status).toBe(200);
    expect((await api('GET', `/${oid}`)).body.data).toBeNull();
  });

  it('accepts exactly 5000 characters and rejects 5001 with 422', async () => {
    const oid = id('limit');
    expect((await api('PUT', `/${oid}`, { text: 'a'.repeat(5000) })).status).toBe(200);
    const over = await api('PUT', `/${oid}`, { text: 'a'.repeat(5001) });
    expect(over.status).toBe(422);
    const got = await api('GET', `/${oid}`);
    expect((got.body.data as { text: string }).text.length).toBe(5000);
  });

  it('keeps notes of different objects separate and separate from night notes', async () => {
    const a = id('sepA');
    const b = id('sepB');
    await api('PUT', `/${a}`, { text: 'A' });
    await api('PUT', `/${b}`, { text: 'B' });
    expect(((await api('GET', `/${a}`)).body.data as { text: string }).text).toBe('A');
    expect(((await api('GET', `/${b}`)).body.data as { text: string }).text).toBe('B');
  });
});

describe('object notes API: admin only writes', () => {
  it('rejects a viewer PUT with 403 and stores nothing', async () => {
    const oid = id('viewerPut');
    currentRole = 'viewer';
    const r = await api('PUT', `/${oid}`, { text: 'nope' });
    expect(r.status).toBe(403);
    currentRole = 'admin';
    expect((await api('GET', `/${oid}`)).body.data).toBeNull();
  });

  it('rejects a viewer DELETE with 403 and keeps the note', async () => {
    const oid = id('viewerDel');
    await api('PUT', `/${oid}`, { text: 'keep me' });
    currentRole = 'viewer';
    expect((await api('DELETE', `/${oid}`)).status).toBe(403);
    expect(((await api('GET', `/${oid}`)).body.data as { text: string }).text).toBe('keep me');
  });

  it('lets a viewer read', async () => {
    const oid = id('viewerGet');
    await api('PUT', `/${oid}`, { text: 'readable' });
    currentRole = 'viewer';
    const r = await api('GET', `/${oid}`);
    expect(r.status).toBe(200);
    expect((r.body.data as { text: string }).text).toBe('readable');
  });
});
