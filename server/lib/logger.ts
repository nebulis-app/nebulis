/**
 * Structured logger — MUST be the first side-effect import in index.ts.
 *
 * What it does:
 *  1. Builds a pino instance that emits JSON simultaneously to:
 *       - stdout (captured by NSSM on Windows, by Docker/journald elsewhere)
 *       - <LOGS_DIR>/server.log with simple 10 MB size rotation
 *  2. In development (NODE_ENV !== 'production') the stdout stream is
 *     pretty-printed when pino-pretty is installed, otherwise it falls back
 *     to JSON. The file stream is always JSON so log shippers can parse it.
 *  3. Reads LOG_LEVEL from env (default 'info').
 *  4. Includes requestId from the AsyncLocalStorage in lib/requestContext on
 *     every log line emitted during request handling, via pino's mixin hook.
 *  5. Overrides console.log / warn / error / info / debug so existing call
 *     sites route through pino without code changes.
 *  6. Registers uncaughtException + unhandledRejection handlers so startup
 *     crashes (e.g. SQLite errors during db.ts init) are written to disk
 *     before the process exits.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import pino from 'pino';
import type { DestinationStream } from 'pino';
import { LOGS_DIR } from './paths.js';
import { requestContext } from './requestContext.js';

const require = createRequire(import.meta.url);

// On macOS, launchd captures stdout/stderr to ~/Library/Logs/Nebulis/.
// Truncate both files before any output so each restart begins with a clean log.
// O_APPEND mode (used by launchd) guarantees subsequent writes start at offset 0
// after truncation, so the file descriptor stays valid.
if (process.platform === 'darwin') {
  const macLogsDir = path.join(os.homedir(), 'Library', 'Logs', 'Nebulis');
  for (const name of ['stdout.log', 'stderr.log']) {
    try { fs.truncateSync(path.join(macLogsDir, name), 0); } catch { /* not under launchd */ }
  }
}

const LOG_PATH = path.join(LOGS_DIR, 'server.log');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PROD = process.env.NODE_ENV === 'production';

// Rotate if the existing log file is over 10 MB
try {
  if (fs.statSync(LOG_PATH).size > 10 * 1024 * 1024) {
    fs.renameSync(LOG_PATH, path.join(LOGS_DIR, 'server.log.old'));
  }
} catch { /* file doesn't exist yet — that's fine */ }

// Write a startup banner directly to the file before pino is configured so
// even a fatal crash during module init has a visible timestamp in the log.
try {
  fs.appendFileSync(LOG_PATH, `\n=== ${new Date().toISOString()} starting ===\n`);
} catch { /* best-effort */ }

const fileStream = pino.destination({ dest: LOG_PATH, sync: true, mkdir: true });

// In dev, try to pretty-print stdout. If pino-pretty isn't available, fall
// back to a plain JSON stdout stream rather than crashing the boot.
function buildStdoutStream(): DestinationStream {
  if (IS_PROD) {
    return pino.destination({ dest: 1, sync: false });
  }
  try {
    // Resolved lazily so production builds without pino-pretty don't fail.
    const prettyFactory = require('pino-pretty') as (opts?: unknown) => DestinationStream;
    return prettyFactory({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    });
  } catch {
    return pino.destination({ dest: 1, sync: false });
  }
}

// --- debug-capture tee ------------------------------------------------------
// While an admin has the Danger Zone debug capture window open, every pino
// line (at whatever level, including 'debug') is also appended to that
// capture file — not just the plain-text debugLog() narration lines. This
// stream is registered with an explicit 'trace' level so pino's per-stream
// filtering forwards debug-level records to it even though stdout/server.log
// stay at their configured level and never see the extra noise.
// Capped so a long-running capture on a huge import can't grow unbounded.
const MAX_DEBUG_TEE_BYTES = 50 * 1024 * 1024;
let debugTeeFile: string | null = null;
let debugTeeTruncated = false;

export function setDebugTeeTarget(filePath: string | null): void {
  debugTeeFile = filePath;
  debugTeeTruncated = false;
}

/** Also used by debugLogger.ts's debugLog() so both writers share one size cap. */
export function writeDebugLine(line: string): void {
  if (!debugTeeFile) return;
  try {
    const { size } = fs.statSync(debugTeeFile);
    if (size > MAX_DEBUG_TEE_BYTES) {
      if (!debugTeeTruncated) {
        debugTeeTruncated = true;
        fs.appendFileSync(debugTeeFile, '\n=== Debug log truncated: exceeded 50 MB cap ===\n', 'utf8');
      }
      return;
    }
  } catch { /* file not created yet — fall through and attempt the write */ }
  try { fs.appendFileSync(debugTeeFile, line, 'utf8'); } catch { /* best-effort */ }
}

const debugTeeStream: DestinationStream = {
  write(chunk: string) { writeDebugLine(chunk); },
};

const streams: Array<{ stream: DestinationStream; level?: string }> = [
  { stream: buildStdoutStream() },
  { stream: fileStream },
  { stream: debugTeeStream, level: 'trace' },
];

export const log = pino(
  {
    level: LOG_LEVEL,
    base: undefined, // drop pid/hostname; NSSM and Docker already tag those
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = requestContext.getStore();
      return ctx ? { requestId: ctx.requestId } : {};
    },
  },
  pino.multistream(streams),
);

// --- console.* override ---------------------------------------------------
// Routes legacy console calls through pino so existing code keeps working
// while gaining structure (level + timestamp + requestId). Callers that want
// real structured fields should import { log } and pass an object.

function asMessage(args: unknown[]): { msg: string; obj?: Record<string, unknown> } {
  // Surface any Error argument as a structured `err` field so pino's
  // serializer keeps the stack and message. `console.error('prefix:', err)`
  // is the common pattern, so we scan every position, not just args[0].
  const errIdx = args.findIndex(a => a instanceof Error);
  if (errIdx !== -1) {
    const err = args[errIdx] as Error;
    const rest = args.filter((_, i) => i !== errIdx);
    const prefix = rest
      .map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
      .join(' ')
      .trim();
    const msg = prefix ? `${prefix} ${err.message}` : err.message;
    return { msg, obj: { err } };
  }
  const msg = args
    .map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
    .join(' ');
  return { msg };
}

console.log = (...args: unknown[]) => {
  const { msg, obj } = asMessage(args);
  if (obj) log.info(obj, msg); else log.info(msg);
};
console.info = (...args: unknown[]) => {
  const { msg, obj } = asMessage(args);
  if (obj) log.info(obj, msg); else log.info(msg);
};
console.warn = (...args: unknown[]) => {
  const { msg, obj } = asMessage(args);
  if (obj) log.warn(obj, msg); else log.warn(msg);
};
console.error = (...args: unknown[]) => {
  const { msg, obj } = asMessage(args);
  if (obj) log.error(obj, msg); else log.error(msg);
};
console.debug = (...args: unknown[]) => {
  const { msg, obj } = asMessage(args);
  if (obj) log.debug(obj, msg); else log.debug(msg);
};

// --- crash capture --------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  const sysErr = err as NodeJS.ErrnoException;

  // bonjour-service sends mDNS multicast packets asynchronously. On networks
  // that don't support multicast (or when the interface isn't up at boot time)
  // the kernel throws ENETUNREACH on 224.0.0.x:5353. This is non-fatal — the
  // server works fine without mDNS advertisement.
  const addr = (sysErr as NodeJS.ErrnoException & { address?: string }).address ?? '';
  if (sysErr.code === 'ENETUNREACH' && addr.startsWith('224.0.0.')) {
    log.warn('mDNS: network unreachable, advertisement disabled');
    return;
  }

  log.fatal({ err }, 'uncaughtException');
  setTimeout(() => process.exit(1), 100).unref();
});

process.on('unhandledRejection', (reason: unknown) => {
  if (reason instanceof Error) {
    log.fatal({ err: reason }, 'unhandledRejection');
  } else {
    log.fatal({ reason: String(reason) }, 'unhandledRejection');
  }
});

log.info({ logFile: LOG_PATH, level: LOG_LEVEL }, `Log file: ${LOG_PATH}`);
