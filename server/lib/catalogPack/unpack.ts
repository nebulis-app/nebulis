/**
 * Safe tar.gz extraction for catalog asset packs.
 *
 * Security measures applied on every extraction:
 *   1. Path allowlist — only images/ and JSON sidecars pass; everything else
 *      is dropped silently (path traversal attempts are normalized by the tar
 *      library before reaching filter, then caught by the allowlist regex).
 *   2. Decompression-bomb guard — declared entry sizes are summed via the
 *      filter callback; extraction aborts if they exceed the manifest's
 *      declared totalBytes + margin.
 *   3. Per-file SHA-256 is verified by the caller (install.ts) AFTER
 *      extraction using the signed manifest.
 *
 * Extraction is always to an isolated tmp directory. The caller moves files
 * into sky-cache/ only after all verifications pass (atomic install).
 */

import fs from 'node:fs';
import path from 'node:path';
import { extract } from 'tar';

// Matches the exact filenames the server expects in sky-cache/:
//   images/hubble_M1.webp, images/M1_master.jpg, descriptions.json, credits.json
const ALLOWED_PATH_RE =
  /^images\/(hubble_[A-Z0-9_-]+\.webp|sh2_[0-9]+_hubble_[A-Z0-9_]+\.webp|[A-Z0-9_-]+_master\.jpg)$|^(descriptions|credits)\.json$/;

export interface UnpackResult {
  /** Absolute paths of files that were written to destDir. */
  extractedPaths: string[];
  /** Total bytes extracted (summed from tar entry headers). */
  totalBytesExtracted: number;
}

/**
 * Extract a catalog pack archive (.tar.gz) into destDir.
 *
 * @param archivePath  - Absolute path to the .tar.gz file.
 * @param destDir      - Directory to extract into (must exist).
 * @param maxBytes     - Maximum allowed extracted bytes (manifest totalBytes + margin).
 * @returns UnpackResult with extracted file paths and byte count.
 * @throws  If the bomb guard fires or I/O fails.
 */
export async function extractPack(
  archivePath: string,
  destDir: string,
  maxBytes: number,
): Promise<UnpackResult> {
  let totalBytesExtracted = 0;
  let bombDetected = false;
  const allowedEntryPaths = new Set<string>();

  await extract({
    file: archivePath,
    cwd: destDir,
    strict: true,
    filter(entryPath, stat) {
      if (!ALLOWED_PATH_RE.test(entryPath)) return false;
      if (bombDetected) return false;

      const entrySize = stat.size ?? 0;
      totalBytesExtracted += entrySize;
      if (totalBytesExtracted > maxBytes) {
        bombDetected = true;
        return false;
      }

      allowedEntryPaths.add(entryPath);
      return true;
    },
  });

  if (bombDetected) {
    throw new Error(
      `Decompression bomb: extracted ${totalBytesExtracted} bytes exceeds limit of ${maxBytes}`,
    );
  }

  // Build list of absolute paths that were extracted
  const extractedPaths = Array.from(allowedEntryPaths).map(p =>
    path.join(destDir, p),
  );

  return { extractedPaths, totalBytesExtracted };
}
