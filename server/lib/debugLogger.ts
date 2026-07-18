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
import { execFileSync } from 'child_process';
import { LOGS_DIR } from './paths.js';
import { log, setDebugTeeTarget, writeDebugLine } from './logger.js';
import { requestContext } from './requestContext.js';

const DEBUG_TIMEOUT_MS = 15 * 60 * 1000;

/** Best-effort swap usage. Unlike os.freemem() (which reports only truly-free
 *  pages and sits near zero as normal behavior on macOS), swap usage is a real
 *  memory-pressure signal. Platform-specific, wrapped so it can never throw. */
function getSwapSummary(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { timeout: 1500, encoding: 'utf8' });
      const toMb = (v: string, u: string) => Math.round(parseFloat(v) * (u.toUpperCase() === 'G' ? 1024 : 1));
      const used = out.match(/used\s*=\s*([\d.]+)([MG])/i);
      const total = out.match(/total\s*=\s*([\d.]+)([MG])/i);
      if (used && total) return `${toMb(used[1], used[2])} MB used / ${toMb(total[1], total[2])} MB total`;
    } else if (process.platform === 'linux') {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const t = info.match(/SwapTotal:\s*(\d+)\s*kB/);
      const f = info.match(/SwapFree:\s*(\d+)\s*kB/);
      if (t && f) {
        const totalKb = parseInt(t[1], 10);
        const freeKb = parseInt(f[1], 10);
        return `${Math.round((totalKb - freeKb) / 1024)} MB used / ${Math.round(totalKb / 1024)} MB total`;
      }
    }
  } catch { /* best-effort */ }
  return '(unavailable)';
}

function formatUptime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** True if both paths resolve to the same filesystem/device, null if either
 *  can't be stat'd. Cross-volume staging forces copy-then-delete instead of
 *  rename for every uploaded file, which is much slower for large imports. */
function sameVolume(a: string | undefined, b: string | undefined): boolean | null {
  if (!a || !b) return null;
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return null; }
}

interface DebugLogState {
  enabled: boolean;
  enabledAt: string | null;
  expiresAt: string | null;
  logPath: string | null;
}

/** Credential-free snapshot of one telescope profile for the debug header.
 *  The caller (the enable route) builds this from the stored profile and
 *  intentionally omits the SMB username and password. */
export interface TelescopeDebugInfo {
  name: string;
  model: string;
  kind: string;
  connectionType: string;
  /** SMB host (IP or name). Omitted for local-drive profiles. */
  hostname?: string;
  /** SMB share name. Omitted for local-drive profiles. */
  shareName?: string;
  /** Local mount path. Omitted for SMB profiles. */
  localPath?: string;
  autoImportEnabled: boolean;
  autoImportInterval: number;
  archived: boolean;
  importJpg: boolean;
  importFits: boolean;
  importThumbnails: boolean;
  importSubFrames: boolean;
  importVideos: boolean;
}

export interface DebugContext {
  appVersion?: string;
  libraryDir?: string;
  dataDir?: string;
  /** 'local' or 'network'. A network (SMB) library means every import write
   *  goes over the wire and can stall if the share is slow/unreachable. */
  libraryLocationType?: string;
  settings?: Record<string, unknown>;
  telescopes?: TelescopeDebugInfo[];
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

  const cpuCount = os.cpus().length;
  const load = os.loadavg().map(n => n.toFixed(2)).join(' ');
  const mem = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

  const lines: string[] = [
    '=== Nebulis Import Debug Log ===',
    `Started:  ${now.toISOString()}`,
    `Expires:  ${expiresAt.toISOString()}`,
    '',
    '--- System ---',
    ...(ctx?.appVersion ? [`App:      Nebulis ${ctx.appVersion}`] : []),
    `Node.js:  ${process.version}  ·  server uptime ${formatUptime(process.uptime())}`,
    `OS:       ${os.platform()} ${os.release()} (${os.arch()})  ·  ${cpuCount} CPUs  ·  load ${load}`,
    `Hostname: ${os.hostname()}`,
    // os.freemem() sits near zero on macOS by design (cache/inactive/compressed
    // pages are counted used), so it is not a pressure signal. Report total, and
    // use swap + the server's own RSS as the real memory indicators.
    `RAM:      ${totalMb} MB total  (free-page count is not a pressure signal on macOS; watch Swap)`,
    `Swap:     ${getSwapSummary()}`,
    `Server process: RSS ${mb(mem.rss)} MB · heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)} MB · external ${mb(mem.external)} MB (arrayBuffers ${mb(mem.arrayBuffers)} MB)`,
  ];

  const libDisk = diskLine('Library disk', ctx?.libraryDir);
  const dataDisk = diskLine('Data disk   ', ctx?.dataDir);
  if (libDisk) lines.push(libDisk);
  if (dataDisk) lines.push(dataDisk);

  // Where multer first streams uploads before they are moved into the import
  // staging dir under the data dir. If they are on different volumes, every
  // uploaded file is copied+deleted instead of renamed (EXDEV) — slower at scale.
  const tmpDir = os.tmpdir();
  lines.push(`Upload staging: ${tmpDir}`);
  const sv = sameVolume(tmpDir, ctx?.dataDir);
  if (sv === false) {
    lines.push('  (different volume from data dir: uploaded files are copied, not renamed. Slower for large imports.)');
  } else if (sv === true) {
    lines.push('  (same volume as data dir: fast rename staging)');
  }

  if (ctx?.libraryLocationType) {
    const isNet = ctx.libraryLocationType === 'network';
    lines.push(`Library location: ${ctx.libraryLocationType}${isNet ? '  (SMB share: import writes go over the network and can stall if it is slow or unreachable)' : ''}`);
  }

  if (ctx?.settings) {
    const s = ctx.settings;
    lines.push('', '--- Import settings (global / auto-import) ---');
    lines.push(`JPG: ${s.importJpg}, FITS: ${s.importFits}, Subs: ${s.importSubFrames}, Videos: ${s.importVideos}, Thumbnails: ${s.importThumbnails}`);
    lines.push(`Sync: ${s.syncEnabled}, Auto-import interval: ${s.autoImportInterval} min`);
  }

  if (ctx?.telescopes) {
    lines.push('', `--- Telescopes (${ctx.telescopes.length}) ---`);
    if (ctx.telescopes.length === 0) {
      lines.push('(none configured)');
    }
    ctx.telescopes.forEach((t, i) => {
      const location = t.connectionType === 'local'
        ? (t.localPath || '(no path)')
        : `//${t.hostname || '?'}/${t.shareName || '?'}`;
      const auto = t.autoImportEnabled
        ? `auto-import: on (${t.autoImportInterval} min)`
        : 'auto-import: off';
      const archived = t.archived ? '  [archived]' : '';
      lines.push(`${i + 1}. "${t.name}"  [${t.kind} · ${t.connectionType}]${archived}`);
      lines.push(`     ${location}   ${auto}`);
      lines.push(`     import → JPG:${t.importJpg} FITS:${t.importFits} Thumbs:${t.importThumbnails} Subs:${t.importSubFrames} Video:${t.importVideos}`);
    });
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
