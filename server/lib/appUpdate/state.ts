/**
 * In-memory + on-disk state for the desktop auto-updater.
 *
 * In-memory: the latest manifest check result, surfaced by GET /meta/update so
 * the web UI can show its banner.
 *
 * On-disk: the staged installer and an apply marker live under
 * {DATA_DIR}/updates/. The native helper that performs the privileged install
 * (Windows tray / macOS menubar app) reads these directly — it has no auth
 * token, so a file handoff is simpler and more robust than an HTTP call:
 *
 *   {DATA_DIR}/updates/<installer basename>   the verified, staged installer
 *   {DATA_DIR}/updates/apply.json             written when the user clicks
 *                                             Install; the helper consumes and
 *                                             deletes it after applying.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import type { UpdatePlatform } from './platform.js';
import type { UpdateChannel } from './manifest.js';

export const UPDATES_DIR = path.join(DATA_DIR, 'updates');
export const APPLY_MARKER_PATH = path.join(UPDATES_DIR, 'apply.json');

export interface UpdateStatus {
  platform: UpdatePlatform | null;
  channel: UpdateChannel;
  currentVersion: string;
  latestVersion: string | null;
  latestBuild: number | null;
  updateAvailable: boolean;
  mandatory: boolean;
  notesUrl: string | null;
  /** A verified installer is on disk and ready to apply instantly (Windows). */
  staged: boolean;
  stagedPath: string | null;
  stagedSha256: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

let status: UpdateStatus = {
  platform: null,
  channel: 'stable',
  currentVersion: '0.0.0',
  latestVersion: null,
  latestBuild: null,
  updateAvailable: false,
  mandatory: false,
  notesUrl: null,
  staged: false,
  stagedPath: null,
  stagedSha256: null,
  lastCheckedAt: null,
  lastError: null,
};

/** True while an unconsumed apply marker exists on disk. */
export function isApplyRequested(): boolean {
  return fs.existsSync(APPLY_MARKER_PATH);
}

export function getUpdateStatus(): UpdateStatus & { applyRequested: boolean } {
  // applyRequested is derived from the marker file rather than memory so it
  // clears the instant the native helper consumes (deletes) the marker, and so
  // it reads correctly after a restart.
  return { ...status, applyRequested: isApplyRequested() };
}

export function setUpdateStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch };
}

/**
 * Write the apply marker the native helper polls for. Returns false when there
 * is no update to apply.
 *
 * On Windows the marker carries the verified staged installer path + hash, and
 * the tray refuses to run without them. On macOS there is no staged file (the
 * server delegates download to Sparkle), so the marker is just the signal for
 * the menubar app to invoke Sparkle's check-and-install.
 */
export function requestApply(): boolean {
  if (!status.updateAvailable) return false;
  if (status.platform === 'win-x64' && (!status.staged || !status.stagedPath || !status.stagedSha256)) {
    return false; // Windows must have a verified staged installer first.
  }
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const marker = {
    version: status.latestVersion,
    platform: status.platform,
    installerPath: status.stagedPath,
    sha256: status.stagedSha256,
    requestedAt: Date.now(),
  };
  fs.writeFileSync(APPLY_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
  return true;
}

export function clearApplyMarker(): void {
  try { fs.unlinkSync(APPLY_MARKER_PATH); } catch { /* already gone */ }
}
