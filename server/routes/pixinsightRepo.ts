/**
 * @fileoverview Express router for the PixInsight Update Repository mounted at `/plugins/pixinsight/`.
 *
 * Implements the standard PixInsight repository interface required by PixInsight's
 * `Resources > Updates > Manage Repositories` facility:
 * - `GET /updates.xri`: PixInsight XML update descriptor file
 * - `GET /NebulisConnector.tar.gz`: Gzip-compressed tar archive containing the script
 * - `GET /NebulisConnector.zip`: Zip-compressed alternative archive
 * - `GET /NebulisConnector.js`: Standalone PJSR script for direct execution or manual install
 * - `GET /release.json`: JSON metadata describing available packages and SHA-1 digests
 * - `GET /` and `GET /plugins/pixinsight`: Interactive HTML portal with repository instructions and copy button
 */

import express, { type Request, type Response } from 'express';
import { getPixInsightRepoArtifacts } from '../lib/pixinsightRepo';

export const pixinsightRepoRouter = express.Router();

// Allow public access and CORS for external tools and browser checks
pixinsightRepoRouter.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, User-Agent');
  next();
});

/**
 * GET /plugins/pixinsight/updates.xri
 *
 * Serves the PixInsight XML Repository Information (XRI) document. PixInsight fetches
 * this file when checking for updates to determine available versions, release dates,
 * platform compatibility, and archive checksums.
 */
pixinsightRepoRouter.get('/updates.xri', async (_req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.status(200).send(artifacts.updatesXri);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to generate repository descriptor';
    res.status(500).type('text/plain').send(`PixInsight Repository Error: ${msg}`);
  }
});

/**
 * GET /plugins/pixinsight/NebulisConnector.tar.gz
 *
 * Serves the primary `.tar.gz` distribution package containing the PJSR script installed
 * into PixInsight's `src/scripts/Nebulis/` directory. Provides ETag matching the SHA-1 digest.
 */
pixinsightRepoRouter.get('/NebulisConnector.tar.gz', async (_req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.tar.gz"');
    res.setHeader('Content-Length', artifacts.tarGzBuffer.length);
    res.setHeader('ETag', `"${artifacts.tarGzSha1}"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(artifacts.tarGzBuffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve package';
    res.status(500).type('text/plain').send(`PixInsight Package Error: ${msg}`);
  }
});

/**
 * GET /plugins/pixinsight/NebulisConnector.zip
 *
 * Serves the alternative `.zip` distribution package.
 */
pixinsightRepoRouter.get('/NebulisConnector.zip', async (_req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.zip"');
    res.setHeader('Content-Length', artifacts.zipBuffer.length);
    res.setHeader('ETag', `"${artifacts.zipSha1}"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(artifacts.zipBuffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve package';
    res.status(500).type('text/plain').send(`PixInsight Package Error: ${msg}`);
  }
});

/**
 * GET /plugins/pixinsight/NebulisConnector.js
 *
 * Serves the uncompressed standalone JavaScript PJSR script for direct execution
 * or manual installation via PixInsight's "Script > Feature Scripts...".
 */
pixinsightRepoRouter.get('/NebulisConnector.js', async (_req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="NebulisConnector.js"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(artifacts.scriptContent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve script';
    res.status(500).type('text/plain').send(`PixInsight Script Error: ${msg}`);
  }
});

/**
 * GET /plugins/pixinsight/release.json
 *
 * Serves machine-readable metadata about the connector package, current version,
 * release date, download URLs, and SHA-1 digests.
 */
pixinsightRepoRouter.get('/release.json', async (req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}/plugins/pixinsight/`;

    res.status(200).json({
      name: 'Nebulis PixInsight Repository',
      version: artifacts.version,
      releaseDate: artifacts.releaseDate,
      repositoryUrl: baseUrl,
      manifestUrl: `${baseUrl}updates.xri`,
      packages: {
        tarGz: {
          fileName: 'NebulisConnector.tar.gz',
          downloadUrl: `${baseUrl}NebulisConnector.tar.gz`,
          sha1: artifacts.tarGzSha1,
          sizeBytes: artifacts.tarGzBuffer.length,
        },
        zip: {
          fileName: 'NebulisConnector.zip',
          downloadUrl: `${baseUrl}NebulisConnector.zip`,
          sha1: artifacts.zipSha1,
          sizeBytes: artifacts.zipBuffer.length,
        },
        script: {
          fileName: 'NebulisConnector.js',
          downloadUrl: `${baseUrl}NebulisConnector.js`,
        },
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /plugins/pixinsight/ and GET /plugins/pixinsight
 *
 * Serves the interactive repository portal HTML page, displaying quick setup instructions,
 * current connector version, one-click repository URL copy button, and direct package links.
 */
pixinsightRepoRouter.get(['/', ''], async (req: Request, res: Response): Promise<void> => {
  try {
    const artifacts = await getPixInsightRepoArtifacts();
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const repoUrl = `${protocol}://${host}/plugins/pixinsight/`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nebulis — PixInsight Repository</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f293d;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --code-bg: #030712;
      --badge-bg: #1e293b;
      --green: #10b981;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    .container {
      max-width: 800px;
      margin: 40px auto;
      padding: 0 20px;
    }
    header {
      text-align: center;
      margin-bottom: 36px;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .lead {
      color: var(--text-muted);
      font-size: 1.05rem;
    }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 9999px;
      background: var(--badge-bg);
      border: 1px solid var(--border);
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--accent);
      margin-top: 6px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }
    h2 {
      font-size: 1.25rem;
      margin-top: 0;
      margin-bottom: 16px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    ol {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin-bottom: 12px;
      color: #e5e7eb;
    }
    .code-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem;
      color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 10px 0;
      word-break: break-all;
    }
    .btn-copy {
      background: var(--badge-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .btn-copy:hover {
      background: var(--accent);
      color: #000;
    }
    .links-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .download-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 14px;
      background: #1e293b;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: #fff;
      text-decoration: none;
      transition: all 0.2s;
    }
    .download-btn:hover {
      background: #334155;
      border-color: var(--accent);
    }
    .download-btn .title {
      font-weight: 600;
      font-size: 0.95rem;
    }
    .download-btn .subtitle {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .hash-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
      margin-top: 12px;
    }
    .hash-table td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    .hash-table td.label {
      color: var(--text-muted);
      width: 140px;
    }
    .hash-table td.val {
      font-family: monospace;
      color: #a5f3fc;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Nebulis PixInsight Repository</h1>
      <div class="lead">Automatic software updates &amp; package distribution for PixInsight</div>
      <div class="badge">Version ${artifacts.version} &bull; Released ${artifacts.releaseDate}</div>
    </header>

    <div class="card">
      <h2>1. Add to PixInsight Update Repositories</h2>
      <p style="color: var(--text-muted); margin-top: 0;">Add this repository once in PixInsight to receive automatic updates whenever Nebulis is updated:</p>
      
      <div class="code-box">
        <span id="repoUrl">${repoUrl}</span>
        <button class="btn-copy" onclick="copyRepoUrl()">Copy URL</button>
      </div>

      <ol>
        <li>In PixInsight, open menu: <strong>Resources &gt; Updates &gt; Manage Repositories</strong>.</li>
        <li>Click the <strong>Add</strong> button.</li>
        <li>Paste the repository URL above (including the trailing slash).</li>
        <li>Click <strong>OK</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>2. Install the Connector Script</h2>
      <ol>
        <li>In PixInsight, open menu: <strong>Resources &gt; Updates &gt; Check for Updates</strong>.</li>
        <li>PixInsight will detect <strong>Nebulis Connector for PixInsight (v${artifacts.version})</strong>.</li>
        <li>Click <strong>Apply updates</strong> and restart PixInsight.</li>
        <li>Once restarted, access the plugin from <strong>Script &gt; Nebulis &gt; Nebulis Connector</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>Manual Downloads &amp; Repository Files</h2>
      <div class="links-grid">
        <a class="download-btn" href="updates.xri">
          <span class="title">updates.xri</span>
          <span class="subtitle">PixInsight Repository Manifest</span>
        </a>
        <a class="download-btn" href="NebulisConnector.tar.gz">
          <span class="title">NebulisConnector.tar.gz</span>
          <span class="subtitle">Standard Update Package (${(artifacts.tarGzBuffer.length / 1024).toFixed(1)} KB)</span>
        </a>
        <a class="download-btn" href="NebulisConnector.zip">
          <span class="title">NebulisConnector.zip</span>
          <span class="subtitle">Zip Archive (${(artifacts.zipBuffer.length / 1024).toFixed(1)} KB)</span>
        </a>
        <a class="download-btn" href="NebulisConnector.js">
          <span class="title">NebulisConnector.js</span>
          <span class="subtitle">Standalone PJSR Script</span>
        </a>
      </div>

      <h3 style="font-size: 0.95rem; margin-top: 20px; color: #fff;">Package Integrity (SHA-1)</h3>
      <table class="hash-table">
        <tr>
          <td class="label">NebulisConnector.tar.gz</td>
          <td class="val">${artifacts.tarGzSha1}</td>
        </tr>
        <tr>
          <td class="label">NebulisConnector.zip</td>
          <td class="val">${artifacts.zipSha1}</td>
        </tr>
      </table>
    </div>
  </div>

  <script>
    function copyRepoUrl() {
      const url = document.getElementById('repoUrl').innerText;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.btn-copy');
        btn.innerText = 'Copied!';
        setTimeout(() => { btn.innerText = 'Copy URL'; }, 2000);
      });
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).type('text/plain').send(`PixInsight Repository Error: ${msg}`);
  }
});
