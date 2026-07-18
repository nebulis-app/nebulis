import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

// CLI: node scripts/lib/archive-old-artifacts.mjs <dir> <ext> <version>
// build-dmg.sh / build-dmg-legacy.sh shell out to this file directly rather
// than importing it, so it needs its own entry point — without this guard,
// running the file just defines archiveOldArtifacts() and exits, silently
// archiving nothing (this regressed for months; see git history).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, ext, version] = process.argv.slice(2);
  if (!dir || !ext || !version) {
    console.error('Usage: archive-old-artifacts.mjs <dir> <ext> <version>');
    process.exit(1);
  }
  archiveOldArtifacts(dir, ext, version);
}
