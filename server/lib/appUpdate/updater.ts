/**
 * Background desktop app update checker.
 *
 * Mirrors catalogPack/updater.ts: runs ~90s after startup, then every 6h.
 * Fetches the signed manifest for the configured channel, verifies the
 * Ed25519 signature, and compares the latest version to the running build.
 *
 * When a newer version exists:
 *   - Windows: pre-stage (download + SHA-256 verify) the installer into
 *     {DATA_DIR}/updates/ so the tray can apply it instantly.
 *   - macOS: just report availability — Sparkle in NebulisMac handles the
 *     download/verify/install itself.
 *
 * It never installs anything on its own. The user clicks Install in the web UI
 * (or the native menu), which calls POST /meta/update/apply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, fetchText, downloadToFile } from '../catalogPack/download.js';
import { verifyFileSha256 } from '../catalogPack/verify.js';
import { verifyAppManifestSignature } from './verify.js';
import { AppUpdateIndex, type UpdateChannel } from './manifest.js';
import { getUpdatePlatform, getCurrentVersion, compareVersions } from './platform.js';
import { getSettingsData } from '../telescopes.js';
import { UPDATES_DIR, setUpdateStatus, getUpdateStatus } from './state.js';

const BASE_URL = 'https://downloads.nebulis.app/app/v1';
const STARTUP_DELAY_MS = 90_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let checkTimer: ReturnType<typeof setTimeout> | null = null;

function readChannel(): UpdateChannel {
  try {
    const settings = getSettingsData();
    return settings.updateChannel === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}

/** Whether the user has opted into automatic checking + pre-downloading. */
export function isAutoUpdateEnabled(): boolean {
  try {
    return getSettingsData().autoUpdateEnabled === true;
  } catch {
    return false;
  }
}

/** Auto-poll only for opted-in, packaged desktop builds. */
function shouldAutoPoll(): boolean {
  return isAutoUpdateEnabled()
    && getUpdatePlatform() !== null
    && process.env.NODE_ENV === 'production';
}

export function startAppUpdateChecker(): void {
  const platform = getUpdatePlatform();
  const { version } = getCurrentVersion();
  // Seed status so GET /meta/update reports the right platform even before the
  // first poll (and so non-desktop builds report platform=null to the web UI).
  setUpdateStatus({ platform, currentVersion: version, channel: readChannel() });
  // Auto-poll only when the user has opted in AND this is a packaged desktop
  // build. Off by default. A manual POST /meta/update/check still works in any
  // environment regardless of this setting.
  if (!shouldAutoPoll()) return;
  checkTimer = setTimeout(() => void runUpdateCheck(), STARTUP_DELAY_MS);
}

export function stopAppUpdateChecker(): void {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

/** Run a check now (also used by POST /meta/update/check). Safe to call anytime. */
export async function runUpdateCheck(): Promise<void> {
  // Keep the periodic loop alive only while auto-update is enabled. A manual
  // check still runs the detection below even when auto-update is off; it just
  // doesn't schedule a follow-up.
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = shouldAutoPoll() ? setTimeout(() => void runUpdateCheck(), CHECK_INTERVAL_MS) : null;

  const platform = getUpdatePlatform();
  const { version: currentVersion, build: currentBuild } = getCurrentVersion();
  const channel = readChannel();
  setUpdateStatus({ platform, currentVersion, channel });
  if (!platform) return;

  const controller = new AbortController();
  try {
    const indexUrl = `${BASE_URL}/${channel}/index.json`;
    const sigUrl = `${indexUrl}.sig`;
    const [indexBuf, indexSig] = await Promise.all([
      fetchJson(indexUrl, controller.signal),
      fetchText(sigUrl, controller.signal),
    ]);

    if (!verifyAppManifestSignature(indexBuf, indexSig)) {
      setUpdateStatus({ lastCheckedAt: Date.now(), lastError: 'manifest signature invalid' });
      console.warn('[appUpdate] manifest signature invalid — ignoring');
      return;
    }

    const index = AppUpdateIndex.parse(JSON.parse(indexBuf.toString('utf8')));
    const latest = index.latest;
    setUpdateStatus({ latestBuild: latest.build });

    // Downgrade protection: only ever offer a strictly newer version or build.
    const versionCmp = compareVersions(latest.version, currentVersion);
    if (versionCmp < 0 || (versionCmp === 0 && latest.build <= currentBuild)) {
      setUpdateStatus({
        latestVersion: latest.version,
        updateAvailable: false,
        mandatory: false,
        notesUrl: latest.notesUrl,
        lastCheckedAt: Date.now(),
        lastError: null,
      });
      return;
    }

    // Enforce minUpgradableFrom: in-place upgrade is only safe from recent builds.
    // Older installs must download the installer manually.
    if (compareVersions(currentVersion, latest.minUpgradableFrom) < 0) {
      setUpdateStatus({
        latestVersion: latest.version,
        updateAvailable: false,
        notesUrl: latest.notesUrl,
        lastCheckedAt: Date.now(),
        lastError: `current version ${currentVersion} is too old for an automatic update — please download the installer from nebulis.app`,
      });
      console.warn(`[appUpdate] ${currentVersion} < minUpgradableFrom ${latest.minUpgradableFrom} — blocking in-place update`);
      return;
    }

    const artifact = latest.artifacts[platform];
    if (!artifact) {
      // Newer version exists but no build for this platform/arch yet.
      setUpdateStatus({
        latestVersion: latest.version,
        updateAvailable: false,
        notesUrl: latest.notesUrl,
        lastCheckedAt: Date.now(),
        lastError: `no ${platform} artifact in manifest`,
      });
      return;
    }

    setUpdateStatus({
      latestVersion: latest.version,
      updateAvailable: true,
      mandatory: latest.mandatory,
      notesUrl: latest.notesUrl,
      lastCheckedAt: Date.now(),
      lastError: null,
    });
    console.log(`[appUpdate] ${platform}: update available ${currentVersion} → ${latest.version} (${channel})`);

    // macOS delegates download/install to Sparkle — do not pre-stage.
    if (platform !== 'win-x64') return;

    await stageWindowsInstaller(artifact.url, artifact.sha256, controller.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'aborted') {
      setUpdateStatus({ lastCheckedAt: Date.now(), lastError: msg });
      console.warn('[appUpdate] update check failed:', msg);
    }
  }
}

/**
 * Download the Windows installer into {DATA_DIR}/updates/ and verify its
 * SHA-256 before marking it staged. If a previously staged installer already
 * matches, skip the download. Removes stale installers from older versions.
 */
async function stageWindowsInstaller(url: string, sha256: string, signal: AbortSignal): Promise<void> {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const dest = path.join(UPDATES_DIR, path.basename(new URL(url).pathname));

  // Already staged and intact? Don't re-download. Check the file on disk
  // directly so a service restart doesn't lose the staged state.
  if (fs.existsSync(dest) && verifyFileSha256(dest, sha256)) {
    setUpdateStatus({ staged: true, stagedPath: dest, stagedSha256: sha256 });
    return;
  }

  // Drop any other installers in the staging dir (old versions, partials).
  for (const f of fs.readdirSync(UPDATES_DIR)) {
    if (f === path.basename(dest) || f === 'apply.json') continue;
    try { fs.unlinkSync(path.join(UPDATES_DIR, f)); } catch { /* ignore */ }
  }

  console.log(`[appUpdate] staging installer → ${dest}`);
  await downloadToFile(url, dest, signal);

  if (!verifyFileSha256(dest, sha256)) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    setUpdateStatus({ staged: false, stagedPath: null, stagedSha256: null, lastError: 'staged installer failed SHA-256 check' });
    console.warn('[appUpdate] staged installer failed SHA-256 verification — deleted');
    return;
  }

  setUpdateStatus({ staged: true, stagedPath: dest, stagedSha256: sha256 });
  console.log('[appUpdate] installer staged and verified');
}
