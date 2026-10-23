import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { journalRouter } from '../../server/routes/journal';
import {
  JOURNAL_DIR,
  JournalError,
  addAttachment,
  createEntry,
  deleteAttachment,
  deleteEntry,
  getAttachmentFile,
  listEntries,
  updateEntry,
} from '../../server/lib/journal';

function tempUpload(contents: string): string {
  const p = path.join(os.tmpdir(), `journal-test-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  db.prepare('DELETE FROM journalEntries').run();
  db.prepare('DELETE FROM journalAttachments').run();
  fs.rmSync(JOURNAL_DIR, { recursive: true, force: true });
});

describe('journal entries', () => {
  it('lists newest night first and oldest entry first inside a night', () => {
    const a = createEntry({ night: '2026-10-05', body: 'first' }, new Date('2026-10-06T01:00:00Z'));
    const b = createEntry({ night: '2026-10-06', body: 'later night' }, new Date('2026-10-07T01:00:00Z'));
    const c = createEntry({ night: '2026-10-05', body: 'second' }, new Date('2026-10-06T02:00:00Z'));
    expect(listEntries().map((e) => e.id)).toEqual([b.id, a.id, c.id]);
    expect(listEntries({ night: '2026-10-05' }).map((e) => e.body)).toEqual(['first', 'second']);
    expect(listEntries({ from: '2026-10-06', to: '2026-10-06' }).map((e) => e.id)).toEqual([b.id]);
  });

  it('scopes an entry to an object and a picture, and drops the picture without an object', () => {
    const e = createEntry({ night: '2026-10-06', objectId: 'M42', filePath: 'M42/2026-10-06/stacked.jpg', body: 'tilt in corners' });
    expect(e).toMatchObject({ objectId: 'M42', filePath: 'M42/2026-10-06/stacked.jpg' });
    expect(listEntries({ objectId: 'M42' })).toHaveLength(1);
    expect(createEntry({ night: '2026-10-06', filePath: 'x.jpg' }).filePath).toBeNull();
  });

  it('refuses a bad night and a path that climbs out', () => {
    expect(() => createEntry({ night: '10/06/2026' })).toThrow(JournalError);
    expect(() => createEntry({ night: '2026-10-06', objectId: 'M42', filePath: '../../etc/passwd' })).toThrow(/not valid/);
  });

  it('keeps checklist lines, trims them, and drops empty ones', () => {
    const e = createEntry({ night: '2026-10-06', title: 'Packing', checklist: [{ text: ' Batteries ', done: true }, { text: '  ', done: false }, { text: 'Dew strap', done: false }] });
    expect(e.checklist).toEqual([{ text: 'Batteries', done: true }, { text: 'Dew strap', done: false }]);
    const ticked = updateEntry(e.id, { checklist: [{ text: 'Batteries', done: true }, { text: 'Dew strap', done: true }] });
    expect(ticked.checklist.every((i) => i.done)).toBe(true);
    expect(ticked.title).toBe('Packing');
  });

  it('updates only what is sent', () => {
    const e = createEntry({ night: '2026-10-06', objectId: 'M42', body: 'one' });
    const u = updateEntry(e.id, { body: 'two' });
    expect(u).toMatchObject({ night: '2026-10-06', objectId: 'M42', body: 'two' });
    expect(() => updateEntry('nope', { body: 'x' })).toThrow(/not found/);
  });
});

describe('journal attachments', () => {
  it('stores the file under its own id, keeps the name for display, and consumes the temp file', () => {
    const e = createEntry({ night: '2026-10-06' });
    const tmp = tempUpload('png bytes');
    const a = addAttachment(e.id, { tempPath: tmp, fileName: '../../Site map.PNG', mimeType: 'image/png', size: 9 });
    expect(a.fileName).toBe('Site map.PNG');
    expect(fs.existsSync(tmp)).toBe(false);
    const found = getAttachmentFile(a.id);
    expect(found?.filePath.startsWith(path.join(JOURNAL_DIR, e.id))).toBe(true);
    expect(path.basename(found?.filePath ?? '')).toBe(`${a.id}.png`);
    expect(fs.readFileSync(found?.filePath ?? '', 'utf8')).toBe('png bytes');
    expect(listEntries()[0].attachments.map((x) => x.id)).toEqual([a.id]);
  });

  it('deletes a temp file even when the entry does not exist', () => {
    const tmp = tempUpload('x');
    expect(() => addAttachment('missing', { tempPath: tmp, fileName: 'a.txt', mimeType: 'text/plain', size: 1 })).toThrow(/not found/);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('removes one file, or every file with its entry', () => {
    const e = createEntry({ night: '2026-10-06' });
    const a = addAttachment(e.id, { tempPath: tempUpload('a'), fileName: 'a.txt', mimeType: 'text/plain', size: 1 });
    const b = addAttachment(e.id, { tempPath: tempUpload('b'), fileName: 'b.pdf', mimeType: 'application/pdf', size: 1 });
    const aPath = getAttachmentFile(a.id)?.filePath ?? '';
    expect(deleteAttachment(a.id)).toBe(true);
    expect(fs.existsSync(aPath)).toBe(false);
    expect(getAttachmentFile(b.id)).not.toBeNull();
    expect(deleteEntry(e.id)).toBe(true);
    expect(fs.existsSync(path.join(JOURNAL_DIR, e.id))).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM journalAttachments').get()).toEqual({ n: 0 });
  });
});

describe('journal routes', () => {
  let server: http.Server;
  let base = '';
  let role = 'admin';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = role as 'admin'; next(); });
    app.use('/journal', journalRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { role = 'admin'; });

  const json = (method: string, p: string, body?: unknown) =>
    fetch(`${base}/journal${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('creates, uploads, serves and deletes', async () => {
    const created = await (await json('POST', '/', { night: '2026-10-06', body: 'Clear and calm' })).json();
    const id = created.data.id as string;

    const form = new FormData();
    form.append('file', new Blob(['<html>hi</html>'], { type: 'text/html' }), 'page.html');
    const up = await fetch(`${base}/journal/${id}/attachments`, { method: 'POST', body: form });
    expect(up.status).toBe(200);
    const att = (await up.json()).data;
    expect(att).toMatchObject({ fileName: 'page.html', entryId: id });

    // An uploaded page is never served as a page.
    const file = await fetch(`${base}/journal/attachments/${att.id}`);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await file.text()).toBe('<html>hi</html>');

    const list = await (await json('GET', '/?night=2026-10-06')).json();
    expect(list.data[0].attachments).toHaveLength(1);

    expect((await json('DELETE', `/${id}`)).status).toBe(200);
    expect((await json('GET', `/${id}`)).status).toBe(404);
  });

  it('serves a picture inline', async () => {
    const e = createEntry({ night: '2026-10-06' });
    const a = addAttachment(e.id, { tempPath: tempUpload('img'), fileName: 'map.png', mimeType: 'image/png', size: 3 });
    const r = await fetch(`${base}/journal/attachments/${a.id}`);
    expect(r.headers.get('content-type')).toMatch(/^image\/png/);
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('refuses a bad body and a viewer writing', async () => {
    expect((await json('POST', '/', { night: 'yesterday' })).status).toBe(422);
    role = 'viewer';
    expect((await json('POST', '/', { night: '2026-10-06' })).status).toBe(403);
  });
});
