import fs from 'node:fs';
import path from 'node:path';

/**
 * Move artifacts in `dir` that don't belong to `currentVersion` into
 * `dir/archived/`, so only the current build is visible at the top level.
 * Files already in `archived/` and the `archived/` dir itself are left alone.
 *
 * @param {string} dir           - Absolute path to the release output directory.
 * @param {string} ext           - File extension to consider (e.g. '.exe', '.dmg').
 * @param {string} currentVersion - Version string from package.json (e.g. '1.3.1').
 */
export function archiveOldArtifacts(dir, ext, currentVersion) {
  if (!fs.existsSync(dir)) return;
  const archiveDir = path.join(dir, 'archived');
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'archived') continue;
    if (!entry.toLowerCase().endsWith(ext)) continue;
    if (entry.includes(currentVersion)) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    const src = path.join(dir, entry);
    const dst = path.join(archiveDir, entry);
    fs.renameSync(src, dst);
    console.log(`   archived stale artifact: ${entry}`);
  }
}
