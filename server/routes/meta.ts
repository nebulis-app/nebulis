import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';
import { getUpdateStatus, requestApply } from '../lib/appUpdate/state.js';
import { runUpdateCheck, isAutoUpdateEnabled } from '../lib/appUpdate/updater.js';
import { isDesktopBuild } from '../lib/appUpdate/platform.js';
import { getCurrentVersion } from '../lib/appUpdate/platform.js';

const router = Router();

// Resolve the runtime location of package.json + CHANGELOG.md. The path
// math has to handle three deployment shapes:
//
//   1. Dev:        server/routes/meta.ts → two `..` up land at the repo root
//                  where package.json + CHANGELOG.md live.
//   2. Win/Mac pkg: tsup collapses the whole server into one CJS file at
//                  releases/<plat>/server/index.cjs, so only ONE `..` lands
//                  at releases/<plat>/ where build-mac.mjs / build-win.mjs
//                  write the stub package.json + CHANGELOG.md. The two-`..`
//                  resolve goes one level too high and reads nothing.
//   3. Side-by-side with the exe: pkg snapshot can't read assets in some
//                  edge cases, so try the directory next to process.execPath
//                  as a final fallback.
//
// We try each candidate in order and use the first one that exists.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'package.json'),  // dev
  path.resolve(HERE, '..', 'package.json'),        // bundled server
  path.resolve(HERE, 'package.json'),              // bundled server (snapshot quirk)
  path.resolve(path.dirname(process.execPath), 'package.json'),
];
const CHANGELOG_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'CHANGELOG.md'),
  path.resolve(HERE, '..', 'CHANGELOG.md'),
  path.resolve(HERE, 'CHANGELOG.md'),
  path.resolve(path.dirname(process.execPath), 'CHANGELOG.md'),
];

function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

const PKG_PATH = firstExisting(PKG_CANDIDATES) ?? PKG_CANDIDATES[0];
const CHANGELOG_PATH = firstExisting(CHANGELOG_CANDIDATES) ?? CHANGELOG_CANDIDATES[0];

interface ChangelogEntry {
  version: string;
  build: number;
  date: string;
  sections: Record<string, string[]>;
}

function parseChangelog(): ChangelogEntry[] {
  if (!fs.existsSync(CHANGELOG_PATH)) return [];
  const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const entries: ChangelogEntry[] = [];

  // Split on version headers: ## 1.0 (14) — May 14, 2026
  const blocks = text.split(/^## /m).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0].trim();
    // Match "1.0 (14) — May 14, 2026", "1.2.0 - May 23, 2026", or "1.1.0 — May 18, 2026"
    const m = header.match(/^([\d.]+)(?:\s+\((\d+)\))?\s+[—–-]\s+(.+)$/);
    if (!m) continue;

    const [, version, buildStr, date] = m;
    const sections: Record<string, string[]> = {};
    let current: string | null = null;

    for (const line of lines.slice(1)) {
      const sectionMatch = line.match(/^### (.+)/);
      if (sectionMatch) {
        current = sectionMatch[1].trim();
        sections[current] = [];
        continue;
      }
      if (current && line.startsWith('- ')) {
        sections[current].push(line.slice(2).trim());
      }
    }

    entries.push({ version, build: parseInt(buildStr, 10), date: date.trim(), sections });
  }

  return entries;
}

// Track whether we've already logged the "couldn't find package.json" warning
// so a broken deployment doesn't spam the log on every Help page hit.
let pkgWarnLogged = false;

router.get('/version', (_req: Request, res: Response) => {
  let pkg: { version?: unknown; buildNumber?: unknown } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch (err) {
    if (!pkgWarnLogged) {
      console.warn(
        '[meta/version] could not read package.json; serving fallback. Tried:',
        PKG_CANDIDATES.map(p => `\n  - ${p}`).join(''),
        '\n  (error: ' + (err instanceof Error ? err.message : err) + ')',
      );
      pkgWarnLogged = true;
    }
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const buildNumber = typeof pkg.buildNumber === 'number' ? pkg.buildNumber : 0;
  const [major, minor] = version.split('.');
  res.apiSuccess({
    version,
    shortVersion: `${major}.${minor}`,
    build: buildNumber,
  });
});

router.get('/changelog', (_req: Request, res: Response) => {
  try {
    res.apiSuccess(parseChangelog());
  } catch {
    res.apiError(500, 'CHANGELOG_READ_ERROR', 'Could not read changelog');
  }
});

// ─── Desktop auto-update ────────────────────────────────────────────────────

// Current update status for the running build. Drives the web "update
// available" banner. Read-only, so available to any authenticated client.
router.get('/update', (_req: Request, res: Response) => {
  const s = getUpdateStatus();
  res.apiSuccess({
    platform: isDesktopBuild() ? s.platform : null,
    channel: s.channel,
    autoUpdateEnabled: isAutoUpdateEnabled(),
    currentVersion: s.currentVersion,
    currentBuild: getCurrentVersion().build,
    latestVersion: s.latestVersion,
    latestBuild: s.latestBuild,
    updateAvailable: s.updateAvailable,
    mandatory: s.mandatory,
    notesUrl: s.notesUrl,
    staged: s.staged,
    applyRequested: s.applyRequested,
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.lastError,
  });
});

// Force an immediate check (the "Check for updates" button). Admin-only since
// it triggers a network fetch + potential background download.
router.post('/update/check', requireAdmin, async (_req: Request, res: Response) => {
  try {
    await runUpdateCheck();
    res.apiSuccess(getUpdateStatus());
  } catch (err) {
    res.apiError(500, 'UPDATE_CHECK_FAILED', err instanceof Error ? err.message : 'Update check failed');
  }
});

// Apply the staged update. Writes the marker the native helper (Windows tray /
// macOS menubar app) consumes to perform the privileged install + restart.
router.post('/update/apply', requireAdmin, (_req: Request, res: Response) => {
  const s = getUpdateStatus();
  if (!s.updateAvailable) {
    res.apiError(409, 'NO_UPDATE', 'No update is available to apply.');
    return;
  }
  if (s.platform === 'win-x64' && !s.staged) {
    res.apiError(409, 'NOT_STAGED', 'The update is still downloading. Try again shortly.');
    return;
  }
  if (!requestApply()) {
    res.apiError(409, 'APPLY_FAILED', 'Could not queue the update for install.');
    return;
  }
  res.apiSuccess({ applyRequested: true, version: s.latestVersion });
});

export { router as metaRouter };
