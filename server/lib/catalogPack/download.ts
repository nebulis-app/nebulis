/**
 * HTTP download helpers for catalog asset packs.
 *
 * Supports range-resumable downloads: if a partial file already exists, the
 * download resumes from the byte offset rather than starting over. R2 supports
 * HTTP Range requests on all objects.
 */

import fs from 'node:fs';
import path from 'node:path';

const USER_AGENT = 'Nebulis/1.0 (catalog pack installer)';
const TIMEOUT_MS = 60_000;

/**
 * Download a URL to a local file, resuming from the current file size if a
 * partial download already exists. Overwrites on a 200 response (server
 * doesn't support Range) or starts fresh when `dest` is absent.
 *
 * Throws on network error, HTTP error status, or abort.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  signal: AbortSignal,
  onProgress?: (bytesWritten: number, totalBytes?: number) => void,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let startByte = 0;
  try {
    startByte = fs.statSync(dest).size;
  } catch { /* new file */ }

  const timeoutCtrl = new AbortController();
  // stallTimer is reset on each received chunk so the timeout covers both the
  // initial connection and any stall mid-stream (e.g. a 95 MB installer on a
  // slow link). Without this, clearTimeout after fetch() left the body stream
  // with no timeout at all.
  let stallTimer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

  const combined = anySignal([signal, timeoutCtrl.signal]);

  try {
    const res = await fetch(url, { signal: combined, headers });

    // Headers received — reset stall timer for the body stream.
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);

    if (res.status === 416) {
      // Server says we're past the end — file is already complete.
      return;
    }
    if (res.status === 206) {
      // Partial content — append to existing file.
    } else if (res.ok) {
      // Full response — start fresh (server doesn't support Range or file was absent).
      startByte = 0;
      try { fs.unlinkSync(dest); } catch { /* ok if missing */ }
    } else {
      throw new Error(`HTTP ${res.status} downloading ${url}`);
    }

    if (!res.body) throw new Error(`No response body from ${url}`);

    const totalHeader = res.headers.get('content-length');
    const totalBytes = totalHeader ? startByte + parseInt(totalHeader, 10) : undefined;

    const fd = fs.openSync(dest, startByte > 0 ? 'a' : 'w');
    try {
      let written = startByte;
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(stallTimer);
        if (done) break;
        stallTimer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
        fs.writeSync(fd, value);
        written += value.length;
        onProgress?.(written, totalBytes);
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    clearTimeout(stallTimer);
  }
}

/**
 * Fetch a small JSON resource (index.json, manifest.json) with a timeout.
 * Does not do range-resume — these files are always small (<100 KB).
 */
export async function fetchJson(url: string, signal: AbortSignal): Promise<Buffer> {
  const timeoutCtrl = new AbortController();
  const timeout = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
  const combined = anySignal([signal, timeoutCtrl.signal]);
  try {
    const res = await fetch(url, {
      signal: combined,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch a small text resource (e.g. a .sig file). */
export async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const buf = await fetchJson(url, signal);
  return buf.toString('utf8');
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); return ctrl.signal; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
