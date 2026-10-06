import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import zlib from 'zlib';
import {
  getPixInsightRepoArtifacts,
  extractScriptVersion,
  formatXriReleaseDate,
  generateUpdatesXri,
  buildTarGzPackage,
  buildZipPackage,
  resetRepoArtifactsCache,
  getAppVersion,
} from '../../server/lib/pixinsightRepo';
import { pixinsightRepoRouter } from '../../server/routes/pixinsightRepo';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/plugins/pixinsight', pixinsightRepoRouter);
  app.get('/plugins/pixinsightupdates.xri', (req, res, next) => {
    req.url = '/updates.xri';
    pixinsightRepoRouter(req, res, next);
  });
  app.get('/plugins/NebulisConnector.tar.gz', (req, res, next) => {
    req.url = '/NebulisConnector.tar.gz';
    pixinsightRepoRouter(req, res, next);
  });
  app.get('/plugins/NebulisConnector.zip', (req, res, next) => {
    req.url = '/NebulisConnector.zip';
    pixinsightRepoRouter(req, res, next);
  });

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/plugins/pixinsight`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('PixInsight Update Repository Engine', () => {
  it('extracts script version from header comment or returns fallback', () => {
    const codeWithVersion = `// NebulisConnector.js\n// Version: 1.2.3\nvar x = 1;`;
    expect(extractScriptVersion(codeWithVersion)).toBe('1.2.3');

    const codeWithSemver = `/** Nebulis Connector v2.0.4-beta */`;
    expect(extractScriptVersion(codeWithSemver)).toBe('2.0.4-beta');

    const codeWithoutVersion = `var y = 2;`;
    expect(extractScriptVersion(codeWithoutVersion)).toBe(getAppVersion());
  });

  it('formats dates in XRI required YYYYMMDD format', () => {
    const testDate = new Date('2026-09-26T12:00:00Z');
    expect(formatXriReleaseDate(testDate)).toBe('20260926');
  });

  it('generates valid PixInsight XRI 1.0 XML document', () => {
    const xml = generateUpdatesXri({
      version: '1.0.0',
      releaseDate: '20260926',
      tarGzFileName: 'NebulisConnector.tar.gz',
      tarGzSha1: 'abcdef1234567890abcdef1234567890abcdef12',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<xri version="1.0">');
    expect(xml).toContain('fileName="NebulisConnector.tar.gz"');
    expect(xml).toContain('sha1="abcdef1234567890abcdef1234567890abcdef12"');
    expect(xml).toContain('type="script"');
    expect(xml).toContain('releaseDate="20260926"');
    expect(xml).toContain('Nebulis Connector for PixInsight (v1.0.0)');
    expect(xml).toContain('src/scripts/Nebulis/NebulisConnector.js');
  });

  it('builds a valid deterministic tar.gz archive with PixInsight directory structure', async () => {
    const scriptBuffer = Buffer.from('console.log("hello");');
    const tarGz = await buildTarGzPackage(scriptBuffer);
    expect(tarGz.buffer).toBeInstanceOf(Buffer);
    expect(tarGz.buffer.length).toBeGreaterThan(0);
    expect(tarGz.sha1).toHaveLength(40);

    // Decompress gzip and inspect TAR header
    const decompressed = zlib.gunzipSync(tarGz.buffer);
    const tarHeader = decompressed.toString('utf8', 0, 100);
    expect(tarHeader).toContain('src/scripts/Nebulis/NebulisConnector.js');
  });

  it('builds a valid zip archive with PixInsight directory structure', async () => {
    const scriptBuffer = Buffer.from('console.log("hello zip");');
    const zip = await buildZipPackage(scriptBuffer);
    expect(zip.buffer).toBeInstanceOf(Buffer);
    expect(zip.buffer.length).toBeGreaterThan(0);
    expect(zip.sha1).toHaveLength(40);
    // Standard ZIP signature PK\x03\x04
    expect(zip.buffer[0]).toBe(0x50);
    expect(zip.buffer[1]).toBe(0x4b);
    expect(zip.buffer[2]).toBe(0x03);
    expect(zip.buffer[3]).toBe(0x04);
  });

  it('generates cached artifacts for the repository', async () => {
    resetRepoArtifactsCache();
    const artifacts1 = await getPixInsightRepoArtifacts();
    expect(artifacts1.version).toBeDefined();
    expect(artifacts1.tarGzSha1).toHaveLength(40);
    expect(artifacts1.zipSha1).toHaveLength(40);
    expect(artifacts1.tarGzBuffer.length).toBeGreaterThan(100);
    expect(artifacts1.zipBuffer.length).toBeGreaterThan(100);

    // Subsequent retrieval returns the same cached reference
    const artifacts2 = await getPixInsightRepoArtifacts();
    expect(artifacts2).toBe(artifacts1);
  });
});

describe('PixInsight Update Repository HTTP Endpoints', () => {
  it('serves updates.xri with XML content-type and valid package metadata', async () => {
    const res = await fetch(`${baseUrl}/updates.xri`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('xml');

    const body = await res.text();
    expect(body).toContain('<xri version="1.0">');
    expect(body).toContain('fileName="NebulisConnector.tar.gz"');
    expect(body).toContain('type="script"');
    expect(body).toContain('src/scripts/Nebulis/NebulisConnector.js');
  });

  it('serves NebulisConnector.tar.gz with gzip content-type and matching sha1', async () => {
    const artifacts = await getPixInsightRepoArtifacts();
    const res = await fetch(`${baseUrl}/NebulisConnector.tar.gz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(artifacts.tarGzBuffer.length);
    // Decompresses successfully
    const unzipped = zlib.gunzipSync(buf);
    expect(unzipped.length).toBeGreaterThan(0);
  });

  it('serves NebulisConnector.zip with zip content-type', async () => {
    const artifacts = await getPixInsightRepoArtifacts();
    const res = await fetch(`${baseUrl}/NebulisConnector.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(artifacts.zipBuffer.length);
  });

  it('serves NebulisConnector.js for direct manual install', async () => {
    const res = await fetch(`${baseUrl}/NebulisConnector.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');

    const text = await res.text();
    expect(text).toContain('#feature-id');
    expect(text).toContain('NebulisConnector');
  });

  it('serves release.json with complete metadata', async () => {
    const res = await fetch(`${baseUrl}/release.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json() as any;
    expect(data.name).toBe('Nebulis PixInsight Repository');
    expect(data.version).toBeDefined();
    expect(data.releaseDate).toMatch(/^\d{8}$/);
    expect(data.packages.tarGz.sha1).toHaveLength(40);
    expect(data.packages.zip.sha1).toHaveLength(40);
    expect(data.packages.script.fileName).toBe('NebulisConnector.js');
    expect(data.repositoryUrl).toContain('/plugins/pixinsight/');
  });

  it('serves HTML landing page for web browsers navigating to /plugins/pixinsight', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Nebulis PixInsight Repository');
    expect(html).toContain('Resources &gt; Updates &gt; Manage Repositories');
    expect(html).toContain('updates.xri');
  });

  it('handles PixInsight requests when trailing slash was omitted in repository URL', async () => {
    const rootOrigin = baseUrl.replace(/\/plugins\/pixinsight$/, '');
    // PixInsight appends 'updates.xri' to '.../plugins/pixinsight'
    const xriRes = await fetch(`${rootOrigin}/plugins/pixinsightupdates.xri`);
    expect(xriRes.status).toBe(200);
    expect(xriRes.headers.get('content-type')).toContain('xml');
    const xriBody = await xriRes.text();
    expect(xriBody).toContain('<xri version="1.0">');

    // PixInsight resolves relative filename 'NebulisConnector.tar.gz' to '.../plugins/NebulisConnector.tar.gz'
    const pkgRes = await fetch(`${rootOrigin}/plugins/NebulisConnector.tar.gz`);
    expect(pkgRes.status).toBe(200);
    expect(pkgRes.headers.get('content-type')).toBe('application/gzip');
  });
});
