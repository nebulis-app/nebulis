import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-processing-proj-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  resolveProcessingProjectDir,
  getProcessingProjectSummary,
  saveProcessingProjectFile,
} from '../../server/lib/library/processingProject';
import { stmts } from '../../server/lib/library/objects';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  app.use('/api/v1/library', libraryRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1/library`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function seedObject(objectId: string, folderName: string): void {
  stmts.upsertObject.run(
    objectId, folderName, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  fs.mkdirSync(path.join(LIBRARY_DIR, folderName), { recursive: true });
}

function stagedFile(name: string, contents = 'sample content'): string {
  const p = path.join(os.tmpdir(), `proc-proj-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(p, contents);
  return p;
}

describe('processingProject', () => {
  it('safely resolves processing project directory and prevents traversal', () => {
    seedObject('m31', 'M31');
    const baseDir = resolveProcessingProjectDir('m31');
    expect(baseDir).toBe(path.join(LIBRARY_DIR, 'M31', 'processing_project'));

    // Safe nested path
    const safeSub = resolveProcessingProjectDir('m31', 'icons', 'process.xpsm');
    expect(safeSub).toBe(path.join(LIBRARY_DIR, 'M31', 'processing_project', 'icons', 'process.xpsm'));

    // Directory traversal rejected
    const traversal = resolveProcessingProjectDir('m31', '../../outside.txt');
    expect(traversal).toBeNull();
  });

  it('returns empty summary when processing_project folder does not exist', () => {
    seedObject('m42', 'M42');
    const summary = getProcessingProjectSummary('m42');
    expect(summary.exists).toBe(false);
    expect(summary.fileCount).toBe(0);
    expect(summary.files).toEqual([]);
    expect(summary.relativePath).toBe('M42/processing_project');
  });

  it('saves files into processing_project and retrieves summary', () => {
    seedObject('m45', 'M45');

    // Save icon set
    const src1 = stagedFile('icons.xpsm', '<xml>icons</xml>');
    const res1 = saveProcessingProjectFile('m45', 'icons.xpsm', src1);
    expect(res1.relativePath).toBe('M45/processing_project/icons.xpsm');
    expect(fs.existsSync(res1.savedPath)).toBe(true);

    // Save file in nested directory
    const src2 = stagedFile('notes.txt', 'PixInsight processing notes');
    const res2 = saveProcessingProjectFile('m45', 'notes/workflow.txt', src2);
    expect(res2.relativePath).toBe('M45/processing_project/notes/workflow.txt');
    expect(fs.existsSync(res2.savedPath)).toBe(true);

    // Check summary
    const summary = getProcessingProjectSummary('m45');
    expect(summary.exists).toBe(true);
    expect(summary.fileCount).toBe(2);
    expect(summary.files.some(f => f.relativePath === 'icons.xpsm')).toBe(true);
    expect(summary.files.some(f => f.relativePath === 'notes/workflow.txt')).toBe(true);
  });

  it('rejects traversal in saveProcessingProjectFile', () => {
    seedObject('ngc7000', 'NGC7000');
    const src = stagedFile('hack.txt', 'exploit');
    expect(() => saveProcessingProjectFile('ngc7000', '../../../etc/passwd', src)).toThrow();
  });

  it('exposes processing-project summary via GET endpoint', async () => {
    seedObject('m51', 'M51');
    const res = await fetch(`${baseUrl}/objects/m51/processing-project`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: any };
    expect(body.ok).toBe(true);
    expect(body.data.exists).toBe(false);
    expect(body.data.objectId).toBe('m51');
  });

  it('uploads a file into processing_project via POST endpoint', async () => {
    seedObject('m101', 'M101');
    const blob = new Blob(['PixInsight Process Icons Content'], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, 'process_icons.xpsm');
    formData.append('subPath', 'pixinsight/process_icons.xpsm');

    const postRes = await fetch(`${baseUrl}/objects/m101/processing-project/file`, {
      method: 'POST',
      body: formData,
    });

    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { ok: boolean; data: any };
    expect(postBody.ok).toBe(true);
    expect(postBody.data.relativePath).toBe('M101/processing_project/pixinsight/process_icons.xpsm');

    // Confirm it shows up in GET
    const getRes = await fetch(`${baseUrl}/objects/m101/processing-project`);
    const getBody = (await getRes.json()) as { ok: boolean; data: any };
    expect(getBody.ok).toBe(true);
    expect(getBody.data.exists).toBe(true);
    expect(getBody.data.fileCount).toBe(1);
    expect(getBody.data.files[0].name).toBe('process_icons.xpsm');
  });
});
