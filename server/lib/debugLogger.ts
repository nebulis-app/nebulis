/**
 * Debug import logger.
 *
 * Captures verbose import activity to a plain-text file for a fixed window
 * (default 15 minutes). Enabled and disabled via the Settings → Danger Zone
 * UI. When active, import.ts, dwarfMounts.ts, and the walker layer write one
 * line per event via debugLog(). The file can be downloaded as a .gz from the
 * same UI.
 *
 * The module is a plain singleton — no DB involvement. State is lost on server
 * restart, which is acceptable for a short-lived debug capture.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LOGS_DIR } from './paths.js';
import { log, setDebugTeeTarget, writeDebugLine } from './logger.js';
import { requestContext } from './requestContext.js';

const DEBUG_TIMEOUT_MS = 15 * 60 * 1000;

interface DebugLogState {
  enabled: boolean;
  enabledAt: string | null;
  expiresAt: string | null;
  logPath: string | null;
}

export interface DebugContext {
  appVersion?: string;
  libraryDir?: string;
  dataDir?: string;
  settings?: Record<string, unknown>;
  dbStats?: { objects: number; sessions: number; files: number };
}

let state: DebugLogState = {
  enabled: false,
  enabledAt: null,
  expiresAt: null,
  logPath: null,
};

let expiryTimer: NodeJS.Timeout | null = null;
let previousLogLevel: string | null = null;

export function enableDebugLogging(ctx?: DebugContext): DebugLogState {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEBUG_TIMEOUT_MS);

  // Timestamp-keyed filename so multiple sessions don't collide.
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(LOGS_DIR, `debug-import-${ts}.log`);

  // --- system context (gathered locally) ---
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);

  function diskLine(label: string, dir: string | undefined): string | null {
    if (!dir) return null;
    try {
      const s = fs.statfsSync(dir);
      const freeGb = ((s.bfree * s.bsize) / 1e9).toFixed(1);
      const totalGb = ((s.blocks * s.bsize) / 1e9).toFixed(1);
      return `${label}: ${dir}  (${freeGb} GB free / ${totalGb} GB total)`;
    } catch {
      return `${label}: ${dir}  (stat failed)`;
    }
  }

  const lines: string[] = [
    '=== Nebulis Import Debug Log ===',
    `Started:  ${now.toISOString()}`,
    `Expires:  ${expiresAt.toISOString()}`,
    '',
    '--- System ---',
    ...(ctx?.appVersion ? [`App:      Nebulis ${ctx.appVersion}`] : []),
    `Node.js:  ${process.version}`,
    `OS:       ${os.platform()} ${os.release()} (${os.arch()})`,
    `Hostname: ${os.hostname()}`,
    `RAM:      ${freeMb} MB free / ${totalMb} MB total`,
  ];

  const libDisk = diskLine('Library disk', ctx?.libraryDir);
  const dataDisk = diskLine('Data disk   ', ctx?.dataDir);
  if (libDisk) lines.push(libDisk);
  if (dataDisk) lines.push(dataDisk);

  if (ctx?.settings) {
    const s = ctx.settings;
    lines.push('', '--- Import settings ---');
    lines.push(`JPG: ${s.importJpg}, FITS: ${s.importFits}, Subs: ${s.importSubFrames}, Videos: ${s.importVideos}, Thumbnails: ${s.importThumbnails}`);
    lines.push(`Sync: ${s.syncEnabled}, Auto-import interval: ${s.autoImportInterval} min`);
  }

  if (ctx?.dbStats) {
    const { objects, sessions, files } = ctx.dbStats;
    lines.push('', '--- Library ---');
    lines.push(`${objects} objects · ${sessions} sessions · ${files} files`);
  }

  lines.push('', '================================', '');

  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(logPath, lines.join('\n'), 'utf8');
  } catch { /* best-effort */ }

  state = {
    enabled: true,
    enabledAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    logPath,
  };

  // Tee every pino line (including debug-level) into the capture file, and
  // drop the logger's own level to 'debug' so those lines actually get
  // produced. stdout/server.log stay at their configured level since the
  // tee stream is the only one registered at 'trace' — see logger.ts.
  previousLogLevel = log.level;
  log.level = 'debug';
  setDebugTeeTarget(logPath);

  log.info(
    {
      logPath,
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      freeMemMb: freeMb,
      totalMemMb: totalMb,
      ...(ctx?.appVersion && { appVersion: ctx.appVersion }),
      ...(ctx?.dbStats && { dbStats: ctx.dbStats }),
    },
    '[debug-logging] enabled',
  );

  expiryTimer = setTimeout(() => {
    disableDebugLogging();
  }, DEBUG_TIMEOUT_MS);
  expiryTimer.unref();

  return { ...state };
}

export function disableDebugLogging(): DebugLogState {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (state.enabled && state.logPath) {
    try {
      fs.appendFileSync(
        state.logPath,
        `\n=== Debug logging disabled at ${new Date().toISOString()} ===\n`,
        'utf8',
      );
    } catch { /* best-effort */ }
  }
  setDebugTeeTarget(null);
  if (previousLogLevel) {
    log.level = previousLogLevel;
    previousLogLevel = null;
  }
  log.info('[debug-logging] disabled');
  state = { ...state, enabled: false, expiresAt: null };
  return { ...state };
}

export function getDebugLogStatus(): DebugLogState & { minutesRemaining: number; hasLog: boolean } {
  const minutesRemaining =
    state.enabled && state.expiresAt
      ? Math.max(0, Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / 60_000))
      : 0;
  const hasLog = !!state.logPath && fs.existsSync(state.logPath);
  return { ...state, minutesRemaining, hasLog };
}

/** Write one line to the debug log file AND stdout. No-op when debug logging is not active. */
export function debugLog(category: string, message: string): void {
  if (!state.enabled || !state.logPath) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23) + ' UTC';
  const requestId = requestContext.getStore()?.requestId;
  const reqPart = requestId ? ` [req:${requestId.slice(0, 8)}]` : '';
  const line = `${ts}  [${category}]${reqPart}  ${message}`;
  writeDebugLine(line + '\n');
  console.log(`[debug:${category}] ${message}`);
}

/** Returns the log file path if it exists, otherwise null. */
export function getDebugLogPath(): string | null {
  return state.logPath && fs.existsSync(state.logPath) ? state.logPath : null;
}

/** Cheap boolean check for hot paths that want to skip building a debugLog() message when capture is off. */
export function isDebugLoggingEnabled(): boolean {
  return state.enabled;
}
