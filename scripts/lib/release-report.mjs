/**
 * HTML report for `npm run release` / `npm run release:beta`.
 *
 * Pure helpers: release.mjs gathers the facts (steps, timings, git state) and
 * calls collectDownloads()/checkUrls()/renderReport(). Nothing here uploads or
 * mutates anything; the only side effects are HEAD requests in checkUrls().
 */

import fs from 'node:fs';
import path from 'node:path';

const PLATFORM_LABELS = {
  'win-x64': ['Windows (x64)', 'Installer .exe'],
  'mac-arm64': ['macOS, Apple Silicon', 'DMG, macOS 14+'],
  'mac-x64': ['macOS, Intel', 'DMG, macOS 14+'],
  'mac-arm64-legacy': ['macOS, Apple Silicon (legacy)', 'DMG, macOS 12+'],
  'mac-x64-legacy': ['macOS, Intel (legacy)', 'DMG, macOS 12+'],
};

const APPCAST_RE = /^appcast(-beta)?(-legacy)?-\w+\.xml$/;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Everything a person would download or point a client at for this channel,
 * with full URLs. Reads releases/app-manifest/ (written by gen-app-manifest).
 */
export function collectDownloads({ root, channel, baseUrl, version }) {
  const manifestDir = path.join(root, 'releases', 'app-manifest');
  const base = baseUrl.replace(/\/+$/, '');
  const out = { installers: [], feeds: [], notesUrl: null, archive: [], manifestGeneratedAt: null, build: null };

  const manifestPath = path.join(manifestDir, channel, 'index.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    out.manifestGeneratedAt = manifest.generatedAt ?? null;
    out.notesUrl = manifest.latest?.notesUrl ?? null;
    out.build = manifest.latest?.build ?? null;
    for (const [platform, a] of Object.entries(manifest.latest?.artifacts ?? {})) {
      const [label, kind] = PLATFORM_LABELS[platform] ?? [platform, ''];
      out.installers.push({ platform, label, kind, name: path.basename(a.url), url: a.url, bytes: a.bytes, sha256: a.sha256 });
      if (channel === 'stable') {
        out.archive.push({ name: path.basename(a.url), url: `${base}/versions/${version}/${path.basename(a.url)}` });
      }
    }
    out.feeds.push({ name: `${channel}/index.json`, note: 'Signed update manifest (Windows + macOS)', url: `${base}/app/v1/${channel}/index.json` });
    out.feeds.push({ name: `${channel}/index.json.sig`, note: 'Ed25519 signature', url: `${base}/app/v1/${channel}/index.json.sig` });
  }

  if (fs.existsSync(manifestDir)) {
    for (const f of fs.readdirSync(manifestDir).sort()) {
      if (!APPCAST_RE.test(f)) continue;
      const isBeta = f.startsWith('appcast-beta-');
      if ((channel === 'beta') !== isBeta) continue;
      out.feeds.push({ name: f, note: 'Sparkle appcast (macOS)', url: `${base}/app/v1/${f}` });
    }
  }
  return out;
}

/** HEAD every URL; resolves to { [url]: { ok, status, bytes, error } }. Never throws. */
export async function checkUrls(urls, { timeoutMs = 15000 } = {}) {
  const results = {};
  await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
      const len = Number(res.headers.get('content-length'));
      results[url] = { ok: res.ok, status: res.status, bytes: Number.isFinite(len) && len > 0 ? len : null };
    } catch (err) {
      results[url] = { ok: false, status: null, bytes: null, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  return results;
}

function liveCell(url, live, expectedBytes) {
  if (!live) return '<span class="pill mute">not checked</span>';
  const r = live[url];
  if (!r) return '<span class="pill mute">not checked</span>';
  if (!r.ok) return `<span class="pill bad">${r.status ?? 'unreachable'}</span>`;
  if (expectedBytes && r.bytes && r.bytes !== expectedBytes) return `<span class="pill warn" title="Live size ${r.bytes} differs from manifest ${expectedBytes}">${r.status} size mismatch</span>`;
  return `<span class="pill ok">${r.status} live</span>`;
}

function urlLink(url) {
  return `<a href="${esc(url)}">${esc(url)}</a>`;
}

/** Renders the full self-contained HTML document. */
export function renderReport(d) {
  const failed = d.steps.find(s => s.status === 'failed');
  const verdict = d.dryRun ? 'dry' : failed ? 'failed' : 'ok';
  const verdictText = d.dryRun ? 'Dry run: nothing was uploaded' : failed ? `Failed at: ${failed.label}` : 'Release complete';
  const dl = d.downloads;
  const liveBad = d.live ? Object.values(d.live).filter(r => !r.ok).length : 0;
  const total = d.steps.reduce((sum, s) => sum + (s.ms ?? 0), 0);
  const maxMs = Math.max(1, ...d.steps.map(s => s.ms ?? 0));

  const stepRows = d.steps.map(s => `
      <tr>
        <td><span class="pill ${s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'bad' : 'mute'}">${esc(s.status === 'ok' ? 'done' : s.status)}</span></td>
        <td><code>${esc(s.label)}</code>${s.note ? `<div class="sub">${esc(s.note)}</div>` : ''}</td>
        <td class="num">${s.ms != null ? humanDuration(s.ms) : '-'}</td>
        <td class="bar"><i style="width:${s.ms ? Math.max(2, Math.round((s.ms / maxMs) * 100)) : 0}%"></i></td>
      </tr>`).join('');

  const installerRows = dl.installers.map(i => `
      <tr>
        <td><strong>${esc(i.label)}</strong><div class="sub">${esc(i.kind)}</div></td>
        <td class="url">${urlLink(i.url)}<div class="sub">SHA-256 <code>${esc(i.sha256)}</code></div></td>
        <td class="num">${humanBytes(i.bytes)}</td>
        <td>${liveCell(i.url, d.live, i.bytes)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="sub">No installers were staged.</td></tr>';

  const feedRows = dl.feeds.map(f => `
      <tr>
        <td><strong>${esc(f.name)}</strong><div class="sub">${esc(f.note)}</div></td>
        <td class="url">${urlLink(f.url)}</td>
        <td>${liveCell(f.url, d.live)}</td>
      </tr>`).join('');
  const notesRow = dl.notesUrl ? `
      <tr>
        <td><strong>release-notes.html</strong><div class="sub">Release notes for ${esc(d.version)}</div></td>
        <td class="url">${urlLink(dl.notesUrl)}</td>
        <td>${liveCell(dl.notesUrl, d.live)}</td>
      </tr>` : '';
  const archiveRows = dl.archive.map(a => `
      <tr>
        <td><strong>${esc(a.name)}</strong></td>
        <td class="url">${urlLink(a.url)}</td>
        <td>${liveCell(a.url, d.live)}</td>
      </tr>`).join('');

  const publicSite = d.publicSite
    ? `<div class="kv"><span>Public site</span><b><span class="pill ${d.publicSite.status === 'ok' ? 'ok' : d.publicSite.status === 'failed' ? 'bad' : 'mute'}">${esc(d.publicSite.status)}</span> ${esc(d.publicSite.note ?? '')}</b></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nebulis ${esc(d.channel)} release ${esc(d.version)}</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --ink:#151a2c; --mute:#5d6580; --line:#e3e6f0; --ok:#0b7a4b; --okbg:#dff5ea; --bad:#b4232a; --badbg:#fde4e5; --warn:#8a5a00; --warnbg:#fff0cc; --acc:#4b5cf0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1020; --card:#161a2f; --ink:#e8ebf8; --mute:#98a0bf; --line:#2a2f4a; --ok:#59d79b; --okbg:#12382a; --bad:#ff8087; --badbg:#431a1e; --warn:#f2c35b; --warnbg:#3d2f0c; --acc:#8c98ff; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:24px 16px 64px; }
  main { max-width:1040px; margin:0 auto; }
  h1 { font-size:26px; margin:0 0 4px; }
  h2 { font-size:16px; margin:32px 0 10px; text-transform:uppercase; letter-spacing:.06em; color:var(--mute); }
  a { color:var(--acc); word-break:break-all; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
  .hero { background:var(--card); border:1px solid var(--line); border-left:6px solid var(--ok); border-radius:12px; padding:20px; }
  .hero.failed { border-left-color:var(--bad); } .hero.dry { border-left-color:var(--warn); }
  .verdict { font-size:18px; font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-top:16px; }
  .kv { background:var(--bg); border-radius:8px; padding:10px 12px; } .kv span { display:block; color:var(--mute); font-size:12px; } .kv b { font-weight:600; word-break:break-word; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--mute); font-weight:600; } tr:last-child td { border-bottom:0; }
  .num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; } .url { min-width:260px; }
  .sub { color:var(--mute); font-size:12px; margin-top:2px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; white-space:nowrap; }
  .pill.ok { background:var(--okbg); color:var(--ok); } .pill.bad { background:var(--badbg); color:var(--bad); } .pill.warn { background:var(--warnbg); color:var(--warn); } .pill.mute { background:var(--line); color:var(--mute); }
  td.bar { width:22%; min-width:90px; } td.bar i { display:block; height:8px; border-radius:4px; background:var(--acc); margin-top:7px; }
  footer { margin-top:32px; color:var(--mute); font-size:12px; }
  @media (max-width:640px) { body { padding:16px; } .url { min-width:200px; } }
</style>
</head>
<body>
<main>
  <section class="hero ${verdict}">
    <h1>Nebulis ${esc(d.channel)} release ${esc(d.version)} <span class="sub">build ${esc(dl.build ?? d.buildNumber)}</span></h1>
    <div class="verdict">${esc(verdictText)}</div>
    ${d.live && !d.dryRun ? `<div class="sub">${liveBad === 0 ? 'Every URL below answered a live HEAD request.' : `${liveBad} URL(s) below did not answer 200. Cloudflare may still be propagating; re-check them.`}</div>` : ''}
    <div class="grid">
      <div class="kv"><span>Channel</span><b>${esc(d.channel)} (R2 prefix <code>${esc(d.r2Prefix)}</code>)</b></div>
      <div class="kv"><span>Started</span><b>${esc(d.startedAt)}</b></div>
      <div class="kv"><span>Duration</span><b>${humanDuration(total)}</b></div>
      <div class="kv"><span>Git</span><b>${esc(d.git.branch)} @ <code>${esc(d.git.sha)}</code>${d.git.dirty ? ` <span class="pill warn">${d.git.dirty} uncommitted</span>` : ''}</b><div class="sub">${esc(d.git.subject)}</div></div>
      <div class="kv"><span>Flags</span><b>${esc(d.flags.length ? d.flags.join(' ') : 'none')}</b></div>
      ${publicSite}
    </div>
  </section>

  <h2>Installers</h2>
  <div class="card"><table>
    <thead><tr><th>Platform</th><th>Download URL</th><th class="num">Size</th><th>Live</th></tr></thead>
    <tbody>${installerRows}</tbody>
  </table></div>

  <h2>Update feeds and notes</h2>
  <div class="card"><table>
    <thead><tr><th>File</th><th>URL</th><th>Live</th></tr></thead>
    <tbody>${feedRows}${notesRow}</tbody>
  </table></div>
${archiveRows ? `
  <h2>Versioned archive</h2>
  <div class="card"><table>
    <thead><tr><th>File</th><th>URL</th><th>Live</th></tr></thead>
    <tbody>${archiveRows}</tbody>
  </table></div>` : ''}

  <h2>Steps</h2>
  <div class="card"><table>
    <thead><tr><th>Status</th><th>Step</th><th class="num">Time</th><th></th></tr></thead>
    <tbody>${stepRows}</tbody>
  </table></div>

  <footer>Generated ${esc(d.generatedAt)} by scripts/release.mjs. Downloads are served from ${esc(d.baseUrl)} (Cloudflare R2, bucket <code>${esc(d.bucket)}</code>).</footer>
</main>
</body>
</html>
`;
}
