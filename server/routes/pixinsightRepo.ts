/**
 * @fileoverview PixInsight update repository, mounted at `/plugins/pixinsight/`.
 *
 * Public on purpose (PixInsight's updater sends no credentials) and read-only: it
 * only serves the connector script and packages built from it. The whole router
 * answers 404 unless an admin turned on Settings → Features → PixInsight integration.
 *
 *   GET /updates.xri              update manifest
 *   GET /NebulisConnector.tar.gz  package PixInsight installs
 *   GET /NebulisConnector.zip     same, as zip
 *   GET /NebulisConnector.js      the bare script, for manual install
 *   GET /release.json             machine-readable version + checksums
 *   GET /                         setup page
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { getPixInsightRepoArtifacts, type PixInsightRepoArtifacts } from '../lib/pixinsightRepo.js';
import { getSettingsData } from '../lib/telescopes.js';

export const pixinsightRepoRouter = express.Router();

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Repository base URL, e.g. `http://nebulis.local:8090/plugins/pixinsight/`. */
function baseUrlFor(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}/plugins/pixinsight/`;
}

pixinsightRepoRouter.use((_req: Request, res: Response, next: NextFunction) => {
  if (getSettingsData().pixinsightEnabled !== true) {
    res.status(404).type('text/plain').send('PixInsight integration is turned off. An admin can enable it in Settings → Features.');
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  next();
});

type Send = (a: PixInsightRepoArtifacts, res: Response, req: Request) => void;

function route(paths: string | string[], what: string, send: Send): void {
  pixinsightRepoRouter.get(paths, async (req: Request, res: Response) => {
    try {
      send(await getPixInsightRepoArtifacts(), res, req);
    } catch (err) {
      res.status(500).type('text/plain').send(`PixInsight repository error (${what}): ${err instanceof Error ? err.message : 'unknown'}`);
    }
  });
}

route('/updates.xri', 'manifest', (a, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.send(a.updatesXri);
});

route('/NebulisConnector.tar.gz', 'package', (a, res) => {
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.tar.gz"');
  res.setHeader('ETag', `"${a.tarGzSha1}"`);
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.send(a.tarGzBuffer);
});

route('/NebulisConnector.zip', 'package', (a, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.zip"');
  res.setHeader('ETag', `"${a.zipSha1}"`);
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.send(a.zipBuffer);
});

route('/NebulisConnector.js', 'script', (a, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.js"');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.send(a.scriptContent);
});

route('/release.json', 'release info', (a, res, req) => {
  const base = baseUrlFor(req);
  res.json({
    name: 'Nebulis PixInsight Repository',
    version: a.version,
    releaseDate: a.releaseDate,
    repositoryUrl: base,
    manifestUrl: `${base}updates.xri`,
    packages: {
      tarGz: { fileName: 'NebulisConnector.tar.gz', downloadUrl: `${base}NebulisConnector.tar.gz`, sha1: a.tarGzSha1, sizeBytes: a.tarGzBuffer.length },
      zip: { fileName: 'NebulisConnector.zip', downloadUrl: `${base}NebulisConnector.zip`, sha1: a.zipSha1, sizeBytes: a.zipBuffer.length },
      script: { fileName: 'NebulisConnector.js', downloadUrl: `${base}NebulisConnector.js` },
    },
  });
});

// Interim setup page. The in-app version (themed, translated, behind sign-in) replaces it
// in the UI phase; every interpolated value below is escaped because `Host` is client-controlled.
route(['/', ''], 'setup page', (a, res, req) => {
  const repoUrl = escapeHtml(baseUrlFor(req));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nebulis PixInsight Repository</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}
code{background:rgba(127,127,127,.18);padding:2px 6px;border-radius:4px;word-break:break-all}
li{margin-bottom:8px}
</style></head><body>
<h1>Nebulis PixInsight Repository</h1>
<p>Connector version ${escapeHtml(a.version)} &middot; released ${escapeHtml(a.releaseDate)}</p>
<h2>Install</h2>
<ol>
<li>In PixInsight open <b>Resources &gt; Updates &gt; Manage Repositories</b> and add:<br><code>${repoUrl}</code> (keep the trailing slash)</li>
<li>Run <b>Resources &gt; Updates &gt; Check for Updates</b>, apply, and restart PixInsight.</li>
<li>Open <b>Script &gt; Nebulis &gt; Nebulis Connector</b>, then enter this server's address and an API key (Nebulis &rarr; Settings &rarr; Account &rarr; API keys).</li>
</ol>
<h2>Manual download</h2>
<ul>
<li><a href="NebulisConnector.tar.gz">NebulisConnector.tar.gz</a> <small>sha1 ${escapeHtml(a.tarGzSha1)}</small></li>
<li><a href="NebulisConnector.zip">NebulisConnector.zip</a> <small>sha1 ${escapeHtml(a.zipSha1)}</small></li>
<li><a href="NebulisConnector.js">NebulisConnector.js</a></li>
</ul>
</body></html>`);
});
