/**
 * @fileoverview PixInsight Update Repository packaging and artifact generation engine.
 *
 * Implements the PixInsight XML Repository Information (XRI) update specification.
 * Packages the Nebulis PJSR connector script (`NebulisConnector.js`) into deterministic
 * `.tar.gz` and `.zip` distribution bundles with SHA-1 checksums, and dynamically
 * generates the `updates.xri` repository manifest for automated installation and updates
 * via PixInsight's "Resources > Updates > Manage Repositories" system.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Encapsulates pre-built repository artifacts and checksums.
 */
export interface PixInsightRepoArtifacts {
  /** Semantic version string extracted from the script (e.g. "1.0.0"). */
  version: string;
  /** PixInsight XRI release date format (YYYYMMDD). */
  releaseDate: string;
  /** Raw UTF-8 source code of NebulisConnector.js. */
  scriptContent: string;
  /** Binary buffer of the .tar.gz distribution archive. */
  tarGzBuffer: Buffer;
  /** Lowercase hexadecimal SHA-1 digest of the .tar.gz archive. */
  tarGzSha1: string;
  /** Binary buffer of the .zip distribution archive. */
  zipBuffer: Buffer;
  /** Lowercase hexadecimal SHA-1 digest of the .zip archive. */
  zipSha1: string;
  /** Generated XML content of the updates.xri manifest. */
  updatesXri: string;
  /** Modification timestamp (epoch milliseconds) of the source script when compiled. */
  lastModified: number;
}

let cachedArtifacts: PixInsightRepoArtifacts | null = null;

/**
 * Resolves the absolute path to the PixInsight NebulisConnector.js script.
 *
 * Checks the `PIXINSIGHT_CONNECTOR_PATH` environment variable first, then evaluates
 * candidate relative paths from source and runtime distributions.
 *
 * @returns Absolute filesystem path to NebulisConnector.js.
 * @throws {Error} If NebulisConnector.js cannot be located in any candidate path.
 */
export function resolveConnectorScriptPath(): string {
  if (process.env.PIXINSIGHT_CONNECTOR_PATH && fs.existsSync(process.env.PIXINSIGHT_CONNECTOR_PATH)) {
    return process.env.PIXINSIGHT_CONNECTOR_PATH;
  }

  const candidates = [
    path.resolve(__dirname, '..', '..', 'integrations', 'pixinsight', 'NebulisConnector.js'),
    path.resolve(__dirname, '..', 'integrations', 'pixinsight', 'NebulisConnector.js'),
    path.resolve(process.cwd(), 'integrations', 'pixinsight', 'NebulisConnector.js'),
    path.resolve(path.dirname(process.execPath), 'integrations', 'pixinsight', 'NebulisConnector.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`NebulisConnector.js not found in candidate paths: ${candidates.join(', ')}`);
}

/**
 * Reads the current Nebulis application version from package.json.
 */
export function getAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(path.dirname(process.execPath), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
          return pkg.version.trim();
        }
      }
    } catch { /* try next */ }
  }
  return '2.1.0';
}

/**
 * Reads the NebulisConnector.js script source and ensures NEBULIS_VERSION is
 * strictly aligned with the Nebulis application version from package.json.
 */
export function readNebulisPluginScript(): string {
  const scriptPath = resolveConnectorScriptPath();
  let content = fs.readFileSync(scriptPath, 'utf8');
  const appVersion = getAppVersion();
  if (/var\s+NEBULIS_VERSION\s*=\s*["'][^"']+["']/.test(content)) {
    content = content.replace(
      /var\s+NEBULIS_VERSION\s*=\s*["'][^"']+["']/,
      `var NEBULIS_VERSION = "${appVersion}"`
    );
  }
  return content;
}

/**
 * Extracts the semantic version string from NebulisConnector.js content.
 *
 * Checks first for `NEBULIS_VERSION = "..."` code constant, then searches
 * common version comment formats (e.g. `Version: 1.2.3`), falling back to the Nebulis app version.
 *
 * @param scriptContent - The raw source text of the PJSR script.
 * @returns Cleaned version string (e.g. "2.1.0").
 */
export function extractScriptVersion(scriptContent: string): string {
  // Check for explicit variable declaration
  const varMatch = scriptContent.match(/NEBULIS_VERSION\s*=\s*["']([^"']+)["']/);
  if (varMatch) return varMatch[1];

  // Check for comment versions e.g. "Version: 1.2.3" or "v1.2.3" or "v2.0.4-beta"
  const commentMatch = scriptContent.match(/\b(?:version\s*[:\s]*|v)([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-zA-Z0-9.]+)?)/i);
  if (commentMatch) return commentMatch[1];

  return getAppVersion();
}

/**
 * Formats a Date object into PixInsight XRI releaseDate spec (`YYYYMMDD`).
 *
 * @param date - The Date instance to format (UTC).
 * @returns Date string formatted as YYYYMMDD.
 */
export function formatXriReleaseDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Generates the PixInsight XML Repository Information document (`updates.xri`).
 *
 * Complies with PixInsight's native package distribution schema, defining
 * platform compatibility (`os="all" arch="noarch" version="1.8.8:1.9.9"`),
 * SHA-1 validation, release date, and target installation path
 * (`src/scripts/Nebulis/NebulisConnector.js`).
 *
 * @param options - Packaging options including sha1, version, and release date.
 * @returns The complete XML string for updates.xri.
 */
export function generateUpdatesXri(options: {
  tarGzSha1: string;
  version: string;
  releaseDate: string;
  packageFileName?: string;
}): string {
  const fileName = options.packageFileName || 'NebulisConnector.tar.gz';
  return `<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>
         Nebulis PixInsight Repository &mdash; Astrophotography library workspace and calibration sync.
      </p>
   </description>
   <platform os="all" arch="noarch" version="1.8.0:1.9.9">
      <package fileName="${fileName}"
               sha1="${options.tarGzSha1}"
               type="script"
               releaseDate="${options.releaseDate}">
         <title>
            Nebulis Connector for PixInsight (v${options.version})
         </title>
         <remove>
            src/scripts/Nebulis/NebulisConnector.js
         </remove>
         <description>
            <p>
               Connects PixInsight to Nebulis astrophotography library. Browse catalog objects, download sessions, auto-match calibration frames (darks, flats, bias), and sync processing projects.
            </p>
         </description>
      </package>
   </platform>
</xri>
`;
}

/**
 * Packages the script into a gzip-compressed tar archive (`.tar.gz`).
 *
 * Places the script under `src/scripts/Nebulis/NebulisConnector.js` matching
 * PixInsight's standard installation directory structure. Uses a deterministic
 * entry date for reproducible byte content and stable SHA-1 checksum calculation.
 *
 * @param scriptContent - Raw script content or buffer.
 * @param entryDate - Optional archive entry timestamp (defaults to 2026-01-01 UTC for reproducibility).
 * @returns Object with output buffer and lowercase hex SHA-1 digest.
 */
export function buildTarGzPackage(
  scriptContent: string | Buffer,
  entryDate: Date = new Date(Date.UTC(2026, 0, 1)),
): Promise<{ buffer: Buffer; sha1: string }> {
  return new Promise((resolve, reject) => {
    const archive = archiver('tar', { gzip: true });
    const chunks: Buffer[] = [];

    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
      resolve({ buffer, sha1 });
    });
    archive.on('error', reject);

    archive.append(scriptContent, {
      name: 'src/scripts/Nebulis/NebulisConnector.js',
      date: entryDate,
      mode: 0o644,
    });
    archive.finalize();
  });
}

/**
 * Packages the script into a standard Deflate-compressed zip archive (`.zip`).
 *
 * Places the script under `src/scripts/Nebulis/NebulisConnector.js`. Uses a deterministic
 * entry date for reproducible byte content and stable SHA-1 checksum calculation.
 *
 * @param scriptContent - Raw script content or buffer.
 * @param entryDate - Optional archive entry timestamp (defaults to 2026-01-01 UTC for reproducibility).
 * @returns Object with output buffer and lowercase hex SHA-1 digest.
 */
export function buildZipPackage(
  scriptContent: string | Buffer,
  entryDate: Date = new Date(Date.UTC(2026, 0, 1)),
): Promise<{ buffer: Buffer; sha1: string }> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
      resolve({ buffer, sha1 });
    });
    archive.on('error', reject);

    archive.append(scriptContent, {
      name: 'src/scripts/Nebulis/NebulisConnector.js',
      date: entryDate,
      mode: 0o644,
    });
    archive.finalize();
  });
}

/**
 * Retrieves the compiled repo artifacts, building or serving from cache as appropriate.
 *
 * Checks if cached artifacts match the source script file's `mtimeMs`. If invalidated
 * or if `forceRebuild` is true, re-reads the script, extracts metadata, re-packages
 * `.tar.gz` and `.zip` archives, recomputes SHA-1 digests, and regenerates `updates.xri`.
 *
 * @param forceRebuild - When true, bypasses the memory cache and forces recreation.
 * @returns Promise resolving to the populated {@link PixInsightRepoArtifacts}.
 */
export async function getPixInsightRepoArtifacts(forceRebuild = false): Promise<PixInsightRepoArtifacts> {
  const scriptPath = resolveConnectorScriptPath();
  const stat = fs.statSync(scriptPath);

  if (!forceRebuild && cachedArtifacts && cachedArtifacts.lastModified === stat.mtimeMs) {
    return cachedArtifacts;
  }

  const scriptContent = readNebulisPluginScript();
  const version = extractScriptVersion(scriptContent);
  // Round date to day for deterministic packages
  const entryDate = new Date(Date.UTC(stat.mtime.getUTCFullYear(), stat.mtime.getUTCMonth(), stat.mtime.getUTCDate(), 0, 0, 0));
  const releaseDate = formatXriReleaseDate(stat.mtime);

  const [tarGzResult, zipResult] = await Promise.all([
    buildTarGzPackage(scriptContent, entryDate),
    buildZipPackage(scriptContent, entryDate),
  ]);

  const updatesXri = generateUpdatesXri({
    tarGzSha1: tarGzResult.sha1,
    version,
    releaseDate,
    packageFileName: 'NebulisConnector.tar.gz',
  });

  cachedArtifacts = {
    version,
    releaseDate,
    scriptContent,
    tarGzBuffer: tarGzResult.buffer,
    tarGzSha1: tarGzResult.sha1,
    zipBuffer: zipResult.buffer,
    zipSha1: zipResult.sha1,
    updatesXri,
    lastModified: stat.mtimeMs,
  };

  return cachedArtifacts;
}

/**
 * Invalidates any in-memory cached repo artifacts.
 *
 * Forces subsequent calls to {@link getPixInsightRepoArtifacts} to re-read and rebuild.
 */
export function resetRepoArtifactsCache(): void {
  cachedArtifacts = null;
}
