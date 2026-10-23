/**
 * @fileoverview PixInsight update-repository packaging.
 *
 * Packages the Nebulis PJSR connector script (`server/assets/pixinsight/NebulisConnector.js`)
 * into deterministic `.tar.gz` / `.zip` bundles with SHA-1 checksums, and builds the
 * `updates.xri` manifest PixInsight reads under Resources > Updates > Manage Repositories.
 *
 * The script's `NEBULIS_VERSION` is rewritten to the running app version on the way out,
 * so the plugin, the packages and the manifest can never disagree with the server.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { isRecord } from './typeGuards.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Install path inside the PixInsight package (relative to the PixInsight install dir). */
export const PACKAGE_SCRIPT_PATH = 'src/scripts/Nebulis/NebulisConnector.js';

export interface PixInsightRepoArtifacts {
  version: string;
  /** PixInsight XRI release date (YYYYMMDD). */
  releaseDate: string;
  scriptContent: string;
  tarGzBuffer: Buffer;
  tarGzSha1: string;
  zipBuffer: Buffer;
  zipSha1: string;
  updatesXri: string;
  /** mtimeMs of the source script plus the app version this was built for. */
  cacheKey: string;
}

let cachedArtifacts: PixInsightRepoArtifacts | null = null;

/** Locates NebulisConnector.js: source tree, bundled server, `pkg` snapshot, or an env override. */
export function resolveConnectorScriptPath(): string {
  const override = process.env.PIXINSIGHT_CONNECTOR_PATH;
  if (override && fs.existsSync(override)) return override;

  // The release builds stage the script as `.pjsr`: `pkg` compiles every `.js` it is told to
  // include into bytecode, and this file (PJSR `#engine` directive) is not valid Node JavaScript.
  const rels = ['NebulisConnector.js', 'NebulisConnector.pjsr'].map(f => path.join('assets', 'pixinsight', f));
  const roots = [
    path.resolve(__dirname, '..'),                    // server/lib → server/assets
    __dirname,                                        // bundled beside index.cjs
    path.resolve(__dirname, '..', 'server'),
    path.resolve(process.cwd(), 'server'),
    path.resolve(path.dirname(process.execPath), 'server'),
    path.dirname(process.execPath),
  ];
  const candidates = roots.flatMap(root => rels.map(rel => path.resolve(root, rel)));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`NebulisConnector.js not found. Looked in: ${candidates.join(', ')}`);
}

/** The running app's version from the package.json stub the build writes (same candidates as /meta/version). */
export function getAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(path.dirname(process.execPath), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (isRecord(pkg) && typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    } catch { /* try next */ }
  }
  return '0.0.0';
}

const VERSION_DECL = /var\s+NEBULIS_VERSION\s*=\s*["'][^"']*["']/;

/** Reads the script and pins `NEBULIS_VERSION` to the app version. */
export function readConnectorScript(appVersion: string = getAppVersion()): string {
  const content = fs.readFileSync(resolveConnectorScriptPath(), 'utf8');
  return VERSION_DECL.test(content)
    ? content.replace(VERSION_DECL, `var NEBULIS_VERSION = ${JSON.stringify(appVersion)}`)
    : content;
}

/** The version the script itself declares (after pinning, this equals the app version). */
export function extractScriptVersion(scriptContent: string): string | null {
  const m = scriptContent.match(/NEBULIS_VERSION\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

export function formatXriReleaseDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Builds the PixInsight `updates.xri` manifest. */
export function generateUpdatesXri(options: {
  tarGzSha1: string;
  version: string;
  releaseDate: string;
  packageFileName?: string;
}): string {
  const fileName = xmlEscape(options.packageFileName || 'NebulisConnector.tar.gz');
  return `<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>
         Nebulis PixInsight Repository &mdash; astrophotography library and calibration sync.
      </p>
   </description>
   <platform os="all" arch="noarch" version="1.8.0:1.9.9">
      <package fileName="${fileName}"
               sha1="${options.tarGzSha1}"
               type="script"
               releaseDate="${options.releaseDate}">
         <title>
            Nebulis Connector for PixInsight (v${xmlEscape(options.version)})
         </title>
         <remove>
            ${PACKAGE_SCRIPT_PATH}
         </remove>
         <description>
            <p>
               Connects PixInsight to your Nebulis library. Browse objects, download sessions, pick calibration frames (darks, flats, bias) and sync processing projects.
            </p>
         </description>
      </package>
   </platform>
</xri>
`;
}

function buildArchive(
  kind: 'tar' | 'zip',
  scriptContent: string | Buffer,
  entryDate: Date,
): Promise<{ buffer: Buffer; sha1: string }> {
  return new Promise((resolve, reject) => {
    const archive = kind === 'tar' ? archiver('tar', { gzip: true }) : archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({ buffer, sha1: crypto.createHash('sha1').update(buffer).digest('hex') });
    });
    archive.on('error', reject);
    archive.append(scriptContent, { name: PACKAGE_SCRIPT_PATH, date: entryDate, mode: 0o644 });
    void archive.finalize();
  });
}

/** `.tar.gz` bundle. Fixed entry date keeps the bytes (and so the SHA-1) stable between rebuilds. */
export const buildTarGzPackage = (
  scriptContent: string | Buffer,
  entryDate: Date = new Date(Date.UTC(2026, 0, 1)),
) => buildArchive('tar', scriptContent, entryDate);

/** `.zip` bundle, same layout and determinism rules as the tarball. */
export const buildZipPackage = (
  scriptContent: string | Buffer,
  entryDate: Date = new Date(Date.UTC(2026, 0, 1)),
) => buildArchive('zip', scriptContent, entryDate);

/** Compiled artifacts, cached until the script file or app version changes. */
export async function getPixInsightRepoArtifacts(forceRebuild = false): Promise<PixInsightRepoArtifacts> {
  const scriptPath = resolveConnectorScriptPath();
  const stat = fs.statSync(scriptPath);
  const appVersion = getAppVersion();
  const cacheKey = `${stat.mtimeMs}:${appVersion}`;
  if (!forceRebuild && cachedArtifacts && cachedArtifacts.cacheKey === cacheKey) return cachedArtifacts;

  const scriptContent = readConnectorScript(appVersion);
  const entryDate = new Date(Date.UTC(stat.mtime.getUTCFullYear(), stat.mtime.getUTCMonth(), stat.mtime.getUTCDate()));
  const releaseDate = formatXriReleaseDate(stat.mtime);

  const [tarGz, zip] = await Promise.all([
    buildTarGzPackage(scriptContent, entryDate),
    buildZipPackage(scriptContent, entryDate),
  ]);

  cachedArtifacts = {
    version: appVersion,
    releaseDate,
    scriptContent,
    tarGzBuffer: tarGz.buffer,
    tarGzSha1: tarGz.sha1,
    zipBuffer: zip.buffer,
    zipSha1: zip.sha1,
    updatesXri: generateUpdatesXri({ tarGzSha1: tarGz.sha1, version: appVersion, releaseDate }),
    cacheKey,
  };
  return cachedArtifacts;
}

export function resetRepoArtifactsCache(): void {
  cachedArtifacts = null;
}
