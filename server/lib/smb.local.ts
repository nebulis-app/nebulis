/**
 * Local filesystem implementation of the smb.ts I/O surface. Used when a
 * telescope profile sets connectionType = 'local' — e.g. a Dwarf telescope
 * exposing USB mass storage at /Volumes/DWARF_3 or D:\.
 *
 * Mirrors the smbListDir / smbGetFile / smbDelete signatures so smb.ts can
 * dispatch to one implementation or the other without callers changing.
 *
 * The first argument is always a *share-relative* path (whatever the caller
 * would have passed to SMB). We resolve it against profile.localPath and
 * harden against `..` traversal so a malicious caller can't escape the
 * device's storage root.
 */

import fs from 'fs/promises';
import path from 'path';
import type { SmbEntry } from './smb.shared.js';
import type { TelescopeProfile } from './telescopes.js';

type ProfileArg = Pick<TelescopeProfile, 'localPath'> | null | undefined;

/** Resolve a share-relative path against profile.localPath. Refuses traversal. */
function resolveLocal(profile: ProfileArg, relPath: string): string {
  const root = profile?.localPath?.trim();
  if (!root) throw new Error('Local telescope has no path configured.');
  const absRoot = path.resolve(root);
  // Normalise the share-relative path, then ensure it stays inside the root.
  const candidate = path.resolve(absRoot, relPath);
  // Windows drive roots come back from path.resolve with a trailing separator
  // already (e.g. 'F:\\'); other roots do not. Build the boundary string only
  // when one isn't already there, otherwise the startsWith check looks for a
  // double separator that never matches.
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (candidate !== absRoot && !candidate.startsWith(rootWithSep)) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return candidate;
}

export async function localListDir(relPath: string, profile?: ProfileArg): Promise<SmbEntry[]> {
  const absPath = resolveLocal(profile, relPath);
  let dirents;
  try {
    dirents = await fs.readdir(absPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Match SMB semantics: missing/invalid path returns empty rather than throwing.
      return [];
    }
    throw err;
  }

  const entries: SmbEntry[] = [];
  for (const d of dirents) {
    // Skip macOS resource forks and hidden system files. SMB filters these
    // out at the server side; we replicate that here.
    if (d.name === '.DS_Store' || d.name === 'Thumbs.db' || d.name.startsWith('._')) continue;

    const full = path.join(absPath, d.name);
    let size: number | undefined;
    let mtime: string | undefined;
    if (d.isFile()) {
      try {
        const stat = await fs.stat(full);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch {
        // Race condition: file removed between readdir and stat. Skip.
        continue;
      }
    }
    entries.push({
      name: d.name,
      type: d.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
    });
  }
  return entries;
}

export async function localGetFile(relPath: string, maxBytes?: number, profile?: ProfileArg): Promise<Buffer> {
  const absPath = resolveLocal(profile, relPath);
  // For "thumbnail" / preview reads, callers cap with maxBytes to avoid paging
  // huge FITS files just to extract a header. Honour that here by reading the
  // first N bytes only — full-file reads when maxBytes is undefined.
  if (maxBytes !== undefined && maxBytes > 0) {
    const handle = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  return await fs.readFile(absPath);
}

export async function localPutFile(relPath: string, data: Buffer, profile?: ProfileArg): Promise<void> {
  const absPath = resolveLocal(profile, relPath);
  await fs.writeFile(absPath, data);
}

export async function localDelete(relPath: string, profile?: ProfileArg): Promise<void> {
  const absPath = resolveLocal(profile, relPath);
  try {
    await fs.unlink(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT means already gone — idempotent, matches SMB delete semantics.
    if (code === 'ENOENT') return;
    throw err;
  }
}
