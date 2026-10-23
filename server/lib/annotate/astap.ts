/**
 * ASTAP plate solver: download-on-demand, status, and the solve itself.
 *
 * ASTAP (https://www.hnsky.org/astap.htm, MPL-2.0) is run as a separate
 * executable, never linked. Nothing ships in the installer: the first time a
 * user asks for exact positions, the CLI binary (~1-5 MB) and the D05 star
 * database (~100 MB, enough for fields of 0.6 deg and wider, which covers every
 * smart telescope we know) are fetched from the project's SourceForge page into
 * `<DATA_DIR>/astap/`.
 *
 * Trust: SourceForge publishes no checksums for these files, so the download is
 * integrity-checked only by size and by running the binary once. That is the
 * same trust a user places in installing ASTAP by hand.
 *
 * Solving is serialised (one ASTAP process at a time): each solve is short (a
 * fraction of a second to a few seconds) but memory-hungry on big frames, and a
 * burst of "annotate" clicks across a gallery must not stack them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { DATA_DIR } from '../paths.js';
import { log } from '../logger.js';
import sharp from '../sharp-optional.js';
import type { Wcs } from './wcs.js';
import { childProcessOutput } from '../errors.js';

const SF = 'https://sourceforge.net/projects/astap-program/files';
const DB_URL = `${SF}/star_databases/d05_star_database.zip/download`;
/** A file every D05 install has; cheaper and more honest than counting files. */
const DB_PROBE = /^d05_\d{4}\.1476$/;
const MIN_BINARY_ZIP_BYTES = 200_000;
const MIN_DB_ZIP_BYTES = 50_000_000;
const SOLVE_TIMEOUT_MS = 90_000;
/** A right hint solves in a second or two, so a guess still searching after this is a wrong one. */
const HINTED_TIMEOUT_MS = 20_000;
/** Longest side the solver sees. Matches the viewer's preview tier, so a
 *  solution made here is in the same pixel grid the user is looking at. */
const SOLVE_MAX_PX = 2048;

export const ASTAP_DIR = path.join(DATA_DIR, 'astap');
const DB_DIR = path.join(ASTAP_DIR, 'db');
const BIN_NAME = process.platform === 'win32' ? 'astap_cli.exe' : 'astap_cli';
const BIN_PATH = path.join(ASTAP_DIR, BIN_NAME);

/** The CLI zip for this machine, or null when ASTAP publishes none. */
export function binaryUrlForPlatform(platform = process.platform, arch = process.arch): string | null {
  const zip = (dir: string, file: string) => `${SF}/${dir}/${file}/download`;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? zip('macOS%20installer', 'astap_command-line_version_macOS_M1.zip')
      : zip('macOS%20installer', 'astap_command-line_version_macOS_x86_64.zip');
  }
  if (platform === 'win32') {
    return arch === 'arm64'
      ? zip('windows_installer', 'astap_command-line_version_win11_aarch64.zip')
      : zip('windows_installer', 'astap_command-line_version_win64.zip');
  }
  if (platform === 'linux') {
    if (arch === 'x64') return zip('linux_installer', 'astap_command-line_version_Linux_amd64.zip');
    if (arch === 'arm64') return zip('linux_installer', 'astap_command-line_version_Linux_aarch64.zip');
    if (arch === 'arm') return zip('linux_installer', 'astap_command-line_version_Linux_armhf.zip');
  }
  return null;
}

// ─── Status + install ───────────────────────────────────────────────────────

export type InstallState = 'idle' | 'downloading' | 'extracting' | 'error';

export interface SolverStatus {
  /** ASTAP publishes a build for this OS/CPU. */
  supported: boolean;
  binaryInstalled: boolean;
  dbInstalled: boolean;
  /** Both pieces present: solving can run. */
  ready: boolean;
  state: InstallState;
  /** Human-readable current step while installing. */
  step: string | null;
  /** 0..1 across the whole install. */
  progress: number;
  error: string | null;
}

let installState: InstallState = 'idle';
let installStep: string | null = null;
let installProgress = 0;
let installError: string | null = null;
let installing: Promise<void> | null = null;

function dbPresent(): boolean {
  try {
    return fs.readdirSync(DB_DIR).some(f => DB_PROBE.test(f));
  } catch {
    return false;
  }
}

export function getSolverStatus(): SolverStatus {
  const binaryInstalled = fs.existsSync(BIN_PATH);
  const dbInstalled = dbPresent();
  return {
    supported: binaryUrlForPlatform() !== null,
    binaryInstalled,
    dbInstalled,
    ready: binaryInstalled && dbInstalled,
    state: installState,
    step: installStep,
    progress: installProgress,
    error: installError,
  };
}

const DOWNLOAD_ATTEMPTS = 3;

/** SourceForge sends each request to whichever mirror it picks, and one that is unreachable fails the whole install
 *  on a timeout; a second request usually lands on a different one. */
async function downloadTo(url: string, dest: string, minBytes: number, onProgress: (frac: number) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, dest, minBytes, onProgress);
      return;
    } catch (err) {
      if (attempt >= DOWNLOAD_ATTEMPTS) throw err;
      log.warn({ err, attempt }, '[astap] download failed, trying again');
      onProgress(0);
    }
  }
}

async function downloadOnce(url: string, dest: string, minBytes: number, onProgress: (frac: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (total > 0) onProgress(Math.min(1, seen / total));
      cb(null, chunk);
    },
  });
  await pipeline(res.body, counter, fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  if (size < minBytes) throw new Error(`Download looks incomplete (${size} bytes)`);
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Unpack a zip with the OS's own tool: bsdtar reads zip on macOS and on
 *  Windows 10+, and Linux ships `unzip`. Avoids a zip dependency for a one-off. */
async function extractZip(zip: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'linux') {
    try {
      await run('unzip', ['-o', '-q', zip, '-d', dest], 10 * 60_000);
      return;
    } catch {
      await run('bsdtar', ['-xf', zip, '-C', dest], 10 * 60_000);
      return;
    }
  }
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  await run(tar, ['-xf', zip, '-C', dest], 10 * 60_000);
}

function findFile(dir: string, pred: (name: string) => boolean): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, pred);
      if (hit) return hit;
    } else if (pred(entry.name)) {
      return full;
    }
  }
  return null;
}

async function installBinary(workDir: string, setProgress: (f: number) => void): Promise<void> {
  const url = binaryUrlForPlatform();
  if (!url) throw new Error(`No ASTAP build is published for ${process.platform}/${process.arch}`);
  const zip = path.join(workDir, 'astap_cli.zip');
  await downloadTo(url, zip, MIN_BINARY_ZIP_BYTES, setProgress);
  installState = 'extracting';
  installStep = 'Unpacking the solver';
  const out = path.join(workDir, 'bin');
  await extractZip(zip, out);
  const found = findFile(out, n => /^astap_cli(\.exe)?$/i.test(n));
  if (!found) throw new Error('The ASTAP download did not contain astap_cli');
  fs.mkdirSync(ASTAP_DIR, { recursive: true });
  // Windows builds can ship DLLs beside the exe; keep the whole folder together.
  const srcDir = path.dirname(found);
  for (const entry of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, entry), path.join(ASTAP_DIR, entry === path.basename(found) ? BIN_NAME : entry));
  }
  if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, 0o755);
  // Prove it runs before calling it installed.
  const { stdout, stderr } = await run(BIN_PATH, ['-h'], 20_000).catch(e => ({ stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }));
  if (!/ASTAP/i.test(stdout + stderr)) {
    fs.rmSync(BIN_PATH, { force: true });
    throw new Error('The downloaded solver did not start on this computer');
  }
}

async function installDatabase(workDir: string, setProgress: (f: number) => void): Promise<void> {
  const zip = path.join(workDir, 'd05.zip');
  await downloadTo(DB_URL, zip, MIN_DB_ZIP_BYTES, setProgress);
  installState = 'extracting';
  installStep = 'Unpacking the star database';
  const staging = path.join(workDir, 'db');
  await extractZip(zip, staging);
  const probe = findFile(staging, n => DB_PROBE.test(n));
  if (!probe) throw new Error('The star database download was not what we expected');
  fs.mkdirSync(DB_DIR, { recursive: true });
  const srcDir = path.dirname(probe);
  for (const entry of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, entry), path.join(DB_DIR, entry));
  }
}

/** Start (or join) the install. Resolves when finished; rejects with the same
 *  error `getSolverStatus().error` carries. */
export function installSolver(): Promise<void> {
  if (installing) return installing;
  const status = getSolverStatus();
  if (!status.supported) return Promise.reject(new Error(`ASTAP has no build for ${process.platform}/${process.arch}`));
  if (status.ready) return Promise.resolve();

  installError = null;
  installState = 'downloading';
  installProgress = 0;
  installing = (async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-astap-'));
    try {
      if (!fs.existsSync(BIN_PATH)) {
        installStep = 'Downloading the solver';
        await installBinary(workDir, f => { installProgress = f * 0.05; });
      }
      installProgress = 0.05;
      if (!dbPresent()) {
        installState = 'downloading';
        installStep = 'Downloading the star database (about 100 MB)';
        await installDatabase(workDir, f => { installProgress = 0.05 + f * 0.9; });
      }
      installProgress = 1;
      installState = 'idle';
      installStep = null;
      log.info('[astap] solver installed');
    } catch (err) {
      installState = 'error';
      installStep = null;
      installError = err instanceof Error ? err.message : String(err);
      log.warn(`[astap] install failed: ${installError}`);
      throw err;
    } finally {
      installing = null;
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  })();
  // A rejection here is reported through status/the awaiting caller; the
  // unhandled-rejection guard keeps a fire-and-forget caller from crashing us.
  installing.catch(() => undefined);
  return installing;
}

// ─── Solving ────────────────────────────────────────────────────────────────

export interface SolveHint {
  /** Where the frame is probably centred (the target's catalog position). */
  raDeg?: number;
  decDeg?: number;
  /** Long side of the frame, degrees, if the telescope's field is known. */
  longSideDeg?: number;
}

export class SolveFailedError extends Error {
  constructor(message: string, readonly reason: 'no-solution' | 'not-installed' | 'error') {
    super(message);
    this.name = 'SolveFailedError';
  }
}

let solveChain: Promise<unknown> = Promise.resolve();

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function wcsFromAstapIni(ini: Record<string, string>, width: number, height: number): Wcs | null {
  if (ini.PLTSOLVD !== 'T') return null;
  const n = (k: string): number => Number(ini[k]);
  const wcs: Wcs = {
    crval1: n('CRVAL1'),
    crval2: n('CRVAL2'),
    crpix1: n('CRPIX1'),
    crpix2: n('CRPIX2'),
    cd: { cd11: n('CD1_1'), cd12: n('CD1_2'), cd21: n('CD2_1'), cd22: n('CD2_2') },
    width,
    height,
  };
  const nums = [wcs.crval1, wcs.crval2, wcs.crpix1, wcs.crpix2, wcs.cd.cd11, wcs.cd.cd12, wcs.cd.cd21, wcs.cd.cd22];
  return nums.every(Number.isFinite) ? wcs : null;
}

/** What to hand ASTAP. An image is re-rendered to a bounded JPEG (the same grid
 *  the viewers show); a FITS file is read by ASTAP itself, in place and
 *  read-only: nothing is written next to it, and ASTAP's `-update` (which would
 *  rewrite the header) is never passed. */
export type SolveInput =
  | { kind: 'image'; abs: string }
  | { kind: 'fits'; abs: string; width: number; height: number };

async function solveNow(input: SolveInput, hint: SolveHint): Promise<Wcs> {
  if (!getSolverStatus().ready) throw new SolveFailedError('The plate solver is not installed', 'not-installed');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-solve-'));
  try {
    let file = input.abs;
    let size: { width: number; height: number };
    if (input.kind === 'image') {
      file = path.join(work, 'frame.jpg');
      const info = await sharp(input.abs)
        .resize(SOLVE_MAX_PX, SOLVE_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toFile(file);
      size = { width: info.width, height: info.height };
    } else {
      size = { width: input.width, height: input.height };
    }

    const base = ['-f', file, '-wcs', '-d', DB_DIR, '-o', path.join(work, 'out'), '-z', '0'];
    const position = hint.raDeg != null && hint.decDeg != null
      ? ['-ra', String(hint.raDeg / 15), '-spd', String(hint.decDeg + 90), '-r', '12']
      : ['-r', '180'];
    // ASTAP's -fov is the image HEIGHT in degrees. A field-of-view hint comes
    // from a table (or a guess about which telescope took the frame), so when it
    // finds nothing the solve is repeated with the scale left to ASTAP: a wrong
    // hint must cost time, not the answer.
    const attempts: string[][] = [];
    if (hint.longSideDeg) {
      attempts.push(['-fov', String(hint.longSideDeg * (size.height / Math.max(size.width, size.height)))]);
    }
    attempts.push(['-fov', '0']);

    let wcs: Wcs | null = null;
    let stdout = '';
    for (const [i, fov] of attempts.entries()) {
      const iniPath = path.join(work, 'out.ini');
      fs.rmSync(iniPath, { force: true });
      try {
        ({ stdout } = await run(BIN_PATH, [...base, ...position, ...fov], i < attempts.length - 1 ? HINTED_TIMEOUT_MS : SOLVE_TIMEOUT_MS));
      } catch (err) {
        // ASTAP exits non-zero when it finds no solution; the .ini still tells us.
        stdout = childProcessOutput(err, 'stdout') ?? '';
      }
      const ini = fs.existsSync(iniPath) ? parseIni(fs.readFileSync(iniPath, 'utf8')) : {};
      wcs = wcsFromAstapIni(ini, size.width, size.height);
      if (wcs) break;
    }
    if (!wcs) {
      log.info(`[astap] no solution for ${path.basename(input.abs)}: ${stdout.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
      throw new SolveFailedError('No solution found. The frame may have too few stars, or be too far from the expected position.', 'no-solution');
    }
    return wcs;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Plate-solve an image file or a FITS file. Serialised; throws `SolveFailedError`.
 *
 * A FITS result is in the FITS file's own row order, which is not always the
 * order of a picture made from it: pass it through `wcsFromFitsSolution`.
 */
export function solve(input: SolveInput, hint: SolveHint): Promise<Wcs> {
  const run1 = solveChain.then(() => solveNow(input, hint));
  solveChain = run1.catch(() => undefined);
  return run1;
}
