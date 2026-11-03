import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Same isolation recipe as galleryCropRoute.test.ts: a dot-free temp DATA_DIR
// (sendFile 404s under a dotted path) set before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-gallery-auto-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import type { UserRole } from '../../server/lib/types/userRole';

const OBJECT_ID = 'M33';
/** The object's own processed picture, the normal "pick this one" case. */
const CHOSEN = `${OBJECT_ID}/gallery_${OBJECT_ID}.png`;
/** The cached sky-survey master the route falls back to on `imagePath: null`. */
const SKY = `${OBJECT_ID}/sky_${OBJECT_ID}.jpg`;
const CROP = { x: 0.5, y: 0.5, zoom: 2 };

/** The route declaration, read as text for the admin-guard assertion below. */
const ROUTE_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../server/routes/library.ts', import.meta.url)),
  'utf8',
);

let server: http.Server;
let baseUrl: string;
// The app's own auth middleware is not mounted here, so the role it would have
// set is injected instead. Flipped to 'viewer' by the admin-only case.
let currentRole: UserRole = 'admin';

/** A real PNG for the chosen picture. */
async function writeChosenFixture() {
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#3388ff' } })
    .png()
    .toFile(path.join(LIBRARY_DIR, CHOSEN));
}

/** A real sky-survey JPEG, so the null-without-auto branch has a file to pin. */
async function writeSkyFixture() {
  await sharp({ create: { width: 300, height: 300, channels: 3, background: '#202020' } })
    .jpeg()
    .toFile(path.join(LIBRARY_DIR, SKY));
}

interface GalleryRow {
  galleryImage: string | null;
  galleryImageUserSet: number;
  galleryCrop: string | null;
}

interface GalleryBody {
  ok: boolean;
  data: { objectId: string; galleryImage: string | null } | null;
  error?: { code: string; message: string };
}

function row(): GalleryRow {
  return db.prepare('SELECT galleryImage, galleryImageUserSet, galleryCrop FROM libraryObjects WHERE objectId = ?')
    .get(OBJECT_ID) as GalleryRow;
}

function seedRow(image: string | null, userSet: 0 | 1, crop: string | null) {
  db.prepare('UPDATE libraryObjects SET galleryImage = ?, galleryImageUserSet = ?, galleryCrop = ? WHERE objectId = ?')
    .run(image, userSet, crop, OBJECT_ID);
}

async function putGalleryImage(body: unknown) {
  const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/gallery-image`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as GalleryBody };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID), { recursive: true });
  await writeChosenFixture();
  await writeSkyFixture();
  db.prepare('INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)')
    .run(OBJECT_ID, OBJECT_ID, new Date().toISOString());

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
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Every case starts from the same state a phone's edit sheet finds: the user
// chose a picture and framed it. Without this the cases depend on each other.
beforeEach(() => {
  currentRole = 'admin';
  seedRow(CHOSEN, 1, JSON.stringify(CROP));
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('object gallery image, automatic', () => {
  // Spec criterion 14: `{ imagePath: null, auto: true }` is the "Automatic"
  // choice. It must clear the pin, not re-pin the cached sky image the way a
  // bare null does today.
  it('clearsAUserChoice', async () => {
    expect(row().galleryImageUserSet).toBe(1); // precondition: a pinned, framed picture

    const res = await putGalleryImage({ imagePath: null, auto: true });
    expect(res.status).toBe(200);

    // Asserted first so the red run names the flag, not a downstream symptom.
    const after = row();
    expect(after.galleryImageUserSet).toBe(0);
    expect(after.galleryImage).toBeNull();
    expect(after.galleryCrop).toBeNull();
    expect(res.body.data?.galleryImage).toBeNull();
  });

  // Pins today's behavior for a plain `imagePath: null`, so the new flag stays
  // additive: web's Auto tile keeps sending this body and keeps getting a pin.
  // No `auto` means the route still treats null as "reset to the sky image", and
  // with a `sky_` file on disk (the fixture above) that is a user choice.
  it('keepsTheExistingNullBehaviorWithoutAuto', async () => {
    expect(fs.existsSync(path.join(LIBRARY_DIR, SKY))).toBe(true); // precondition

    const res = await putGalleryImage({ imagePath: null });
    expect(res.status).toBe(200);

    const after = row();
    expect(after.galleryImageUserSet).toBe(1);
    expect(after.galleryImage).toBe(SKY);
    expect(after.galleryCrop).toBeNull(); // the old window meant nothing on a new picture
    expect(res.body.data?.galleryImage).toBe(SKY);
  });

  // A normal pick is unchanged: pin it, store it, drop the crop.
  it('normalPathWriteStillPins', async () => {
    const res = await putGalleryImage({ imagePath: CHOSEN });
    expect(res.status).toBe(200);

    const after = row();
    expect(after.galleryImageUserSet).toBe(1);
    expect(after.galleryImage).toBe(CHOSEN);
    expect(after.galleryCrop).toBeNull();
    expect(res.body.data?.galleryImage).toBe(CHOSEN);
  });

  // Admin-only, as every other library write is. The test app mounts no auth
  // middleware, so this exercises the route's own `requireAdmin` (which reads
  // req.userRole) rather than the header parser; the source assertion guards
  // against the guard being dropped from the declaration.
  it('rejectsANonAdmin', async () => {
    expect(ROUTE_SOURCE).toMatch(
      /router\.put\(\s*'\/objects\/:objectId\/gallery-image'\s*,\s*requireAdmin\b/,
    );

    seedRow(null, 0, null);
    currentRole = 'viewer';
    const res = await putGalleryImage({ imagePath: null, auto: true });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');

    const after = row();
    expect(after.galleryImageUserSet).toBe(0);
    expect(after.galleryImage).toBeNull();
  });

  // The implementer must let `auto` win and ignore `imagePath` when both are
  // sent: a client that switches to Automatic and still carries the old pick
  // must not re-pin it. Not spelled out in the spec's requirement text, so it
  // is the implementer's decision to make the two fields mutually exclusive in
  // auto's favor (and this test says so).
  it('autoIgnoresAPathIfBothAreSent', async () => {
    const res = await putGalleryImage({ imagePath: CHOSEN, auto: true });
    expect(res.status).toBe(200);

    const after = row();
    expect(after.galleryImageUserSet).toBe(0);
    expect(after.galleryImage).toBeNull();
    expect(after.galleryCrop).toBeNull();
    expect(res.body.data?.galleryImage).toBeNull();
  });
});
