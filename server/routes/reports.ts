/**
 * Session Report Generator — all data read from local library only.
 * No SMB calls. Sub-frames must be imported first.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { parseFitsHeader } from '../lib/fitsParser.js';
import { getLibraryDir } from '../lib/libraryPath.js';
import { getCatalogEntry } from '../data/catalog.js';
import { getById as getDsoById } from '../lib/dsoCatalog.js';
import { normalizeCatalogId, parseFilename } from '../lib/telescopeFiles.js';
import { getObjectFolderName } from '../lib/localLibrary.js';
import SunCalc from 'suncalc';

const router = Router();

// In-memory cache for integration stats
const integrationCache = new Map<string, { result: unknown; cachedAt: number }>();
const INTEGRATION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface SessionStats {
  totalFrames: number;
  totalExposureSec: number;
  temperature: number | null;
  gain: number | null;
  filter: string | null;
  dateObs: string | null;
}

/**
 * Read local FITS sub-frames for an object and compute session stats.
 * Looks in LIBRARY_DIR/objectId/ for .fit/.fits files matching the session date.
 */
function computeSessionStats(objectId: string, sessionDate: string): SessionStats | null {
  const LIBRARY_DIR = getLibraryDir();
  const objDir = path.join(LIBRARY_DIR, getObjectFolderName(objectId));
  if (!fs.existsSync(objDir)) return null;

  const dateCompact = sessionDate.replace(/-/g, '');
  const fitsFiles = fs.readdirSync(objDir).filter(
    f => /\.(fit|fits)$/i.test(f) && f.includes(dateCompact)
  );

  if (fitsFiles.length === 0) return null;

  const stats: SessionStats = {
    totalFrames: fitsFiles.length,
    totalExposureSec: 0,
    temperature: null,
    gain: null,
    filter: null,
    dateObs: null,
  };

  for (const fname of fitsFiles.slice(0, 200)) {
    const fullPath = path.join(objDir, fname);
    try {
      const fd = fs.openSync(fullPath, 'r');
      const buf = Buffer.alloc(2880);
      try {
        fs.readSync(fd, buf, 0, 2880, 0);
      } finally {
        fs.closeSync(fd);
      }
      const header = parseFitsHeader(buf);
      const exptime = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
      if (exptime) stats.totalExposureSec += parseFloat(String(exptime));
      if (stats.temperature === null && header.values['CCD-TEMP']) stats.temperature = parseFloat(String(header.values['CCD-TEMP']));
      if (stats.gain === null && header.values['GAIN']) stats.gain = parseFloat(String(header.values['GAIN']));
      if (stats.filter === null && header.values['FILTER']) stats.filter = String(header.values['FILTER']).trim();
      if (stats.dateObs === null && header.values['DATE-OBS']) stats.dateObs = String(header.values['DATE-OBS']).trim();
    } catch { /* skip bad files */ }
  }

  return stats;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// GET /api/v1/reports/session/:objectId/:sessionDate
router.get('/session/:objectId/:sessionDate', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const sessionDate = String(req.params.sessionDate);
  const normalized = normalizeCatalogId(objectId);
  const catalogEntry = getCatalogEntry(normalized) || getDsoById(normalized);
  const objectName = catalogEntry?.name ?? objectId;

  const stats = computeSessionStats(objectId, sessionDate);

  const thumbUrl = `/api/v1/library/objects/${encodeURIComponent(objectId)}/thumbnail`;

  // Moon data for the session date
  let moonHtml = '';
  try {
    const dateForMoon = new Date(sessionDate + 'T22:00:00');
    if (!isNaN(dateForMoon.getTime())) {
      const moon = SunCalc.getMoonIllumination(dateForMoon);
      const illum = Math.round(moon.fraction * 100);
      moonHtml = `<span class="badge">&#x1F319; ${illum}% illuminated</span>`;
    }
  } catch { /* ignore */ }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeObjectName = esc(objectName);
  const safeSessionDate = esc(sessionDate);
  const safeType = esc(catalogEntry?.type ?? '');
  const safeConstellation = catalogEntry?.constellation ? `&middot; ${esc(catalogEntry.constellation)}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeObjectName} — Session ${safeSessionDate} | Nebulis</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  .container { max-width: 860px; margin: 0 auto; }
  .header { display: flex; align-items: flex-start; gap: 2rem; margin-bottom: 2rem; }
  .thumb { width: 220px; height: 165px; object-fit: cover; border-radius: 12px; border: 2px solid #334155; flex-shrink: 0; background: #1e293b; }
  .thumb-placeholder { width: 220px; height: 165px; border-radius: 12px; border: 2px solid #334155; background: #1e293b; display:flex; align-items:center; justify-content:center; color:#475569; font-size:2rem; flex-shrink:0; }
  h1 { font-size: 1.8rem; font-weight: 700; color: #f1f5f9; margin-bottom: 0.25rem; }
  .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 0.75rem; }
  .badges { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .badge { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 0.2rem 0.6rem; font-size: 0.78rem; color: #94a3b8; }
  .badge.accent { background: #1e40af22; border-color: #3b82f6; color: #60a5fa; }
  section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
  h2 { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 1rem; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 1rem; }
  .stat-label { font-size: 0.75rem; color: #64748b; margin-bottom: 0.2rem; }
  .stat-value { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; }
  .stat-value.good { color: #22c55e; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 0.75rem; color: #64748b; font-weight: 500; padding-bottom: 0.5rem; border-bottom: 1px solid #334155; }
  td { padding: 0.4rem 0; font-size: 0.875rem; border-bottom: 1px solid #1e293b; }
  .footer { text-align: center; color: #334155; font-size: 0.75rem; margin-top: 2rem; }
  @media print { body { background: white; color: black; } section { border-color: #e2e8f0; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <img src="${thumbUrl}" alt="${safeObjectName}" class="thumb" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
    <div class="thumb-placeholder" style="display:none">&#x1F52D;</div>
    <div>
      <h1>${safeObjectName}</h1>
      <div class="subtitle">${safeType} ${safeConstellation}</div>
      <div class="badges">
        <span class="badge">&#x1F4C5; ${safeSessionDate}</span>
        ${catalogEntry?.magnitude != null ? `<span class="badge">mag ${catalogEntry.magnitude}</span>` : ''}
        ${moonHtml}
        <span class="badge accent">Nebulis Report</span>
      </div>
    </div>
  </div>

  ${stats ? `
  <section>
    <h2>Integration Summary</h2>
    <div class="stats-grid">
      <div class="stat">
        <div class="stat-label">Total Integration</div>
        <div class="stat-value good">${formatDuration(stats.totalExposureSec)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total Frames</div>
        <div class="stat-value">${stats.totalFrames}</div>
      </div>
      ${stats.gain != null ? `<div class="stat"><div class="stat-label">Gain</div><div class="stat-value">${stats.gain}</div></div>` : ''}
      ${stats.temperature != null ? `<div class="stat"><div class="stat-label">Sensor Temp</div><div class="stat-value">${stats.temperature}&deg;C</div></div>` : ''}
      ${stats.filter ? `<div class="stat"><div class="stat-label">Filter</div><div class="stat-value">${esc(stats.filter)}</div></div>` : ''}
    </div>
  </section>
  ` : `
  <section>
    <p style="color:#64748b">No sub-frame data available for this session.</p>
  </section>
  `}

  <div class="footer">Generated by Nebulis &middot; ${new Date().toLocaleDateString()}</div>
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /api/v1/reports/integration/:objectId
// Aggregate total integration time across all sessions for an object (from local library)
router.get('/integration/:objectId', (req: Request, res: Response) => {
  const LIBRARY_DIR = getLibraryDir();
  const objectId = String(req.params.objectId);

  // Serve from cache if fresh
  const cached = integrationCache.get(objectId);
  if (cached && Date.now() - cached.cachedAt < INTEGRATION_CACHE_TTL_MS) {
    res.apiSuccess(cached.result);
    return;
  }

  const objDir = path.join(LIBRARY_DIR, getObjectFolderName(objectId));
  if (!fs.existsSync(objDir)) {
    const empty = { objectId, totalFrames: 0, totalExposureSec: 0, totalFormatted: '0s', sessions: [] };
    integrationCache.set(objectId, { result: empty, cachedAt: Date.now() });
    res.apiSuccess(empty);
    return;
  }

  const fitsFiles = fs.readdirSync(objDir).filter(f => /\.(fit|fits)$/i.test(f));

  // Group by session date (YYYYMMDD from filename)
  const sessionMap = new Map<string, { frames: number; exposureSec: number }>();
  let totalExposureSec = 0;

  for (const fname of fitsFiles.slice(0, 500)) {
    const dateMatch = fname.match(/(\d{8})/);
    const dateKey = dateMatch
      ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
      : 'unknown';

    try {
      const fullPath = path.join(objDir, fname);
      const fd = fs.openSync(fullPath, 'r');
      const buf = Buffer.alloc(2880);
      try {
        fs.readSync(fd, buf, 0, 2880, 0);
      } finally {
        fs.closeSync(fd);
      }
      const header = parseFitsHeader(buf);
      const exptime = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
      const exp = exptime ? parseFloat(String(exptime)) : 10; // default 10s if missing

      const session = sessionMap.get(dateKey) ?? { frames: 0, exposureSec: 0 };
      session.frames++;
      session.exposureSec += exp;
      sessionMap.set(dateKey, session);
      totalExposureSec += exp;
    } catch { /* skip */ }
  }

  const sessions = Array.from(sessionMap.entries())
    .map(([date, s]) => ({ date, ...s }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = {
    objectId,
    totalFrames: fitsFiles.length,
    totalExposureSec: Math.round(totalExposureSec),
    totalFormatted: formatDuration(totalExposureSec),
    sessions,
  };

  integrationCache.set(objectId, { result, cachedAt: Date.now() });
  res.apiSuccess(result);
});

export { router as reportsRouter };
