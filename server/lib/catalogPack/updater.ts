/**
 * Background catalog pack update checker.
 *
 * Runs once 60 seconds after server startup (to avoid load), then every 24h.
 * Compares the remote index.json against installed pack versions. If any tier
 * has a newer version, installs it silently in the background.
 *
 * Does not run if the prefetch job is already running.
 */

import { fetchJson, fetchText } from './download.js';
import { verifyManifestSignature } from './verify.js';
import { PackIndex, type CatalogTier } from './manifest.js';
import { getAllPackStates } from './state.js';
import { installCatalogPacks } from './install.js';
import { getPrefetchStatus, startPrefetch } from '../catalogPrefetch.js';

const PACK_INDEX_URL = 'https://downloads.nebulis.app/catalog/v1/index.json';
const PACK_INDEX_SIG_URL = 'https://downloads.nebulis.app/catalog/v1/index.json.sig';
const STARTUP_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type PrewarmFn = (id: string, masterPath: string, source: 'hubble' | 'dss2') => Promise<void>;

let checkTimer: ReturnType<typeof setTimeout> | null = null;

export function startPackUpdateChecker(prewarm: PrewarmFn): void {
  checkTimer = setTimeout(() => void runUpdateCheck(prewarm), STARTUP_DELAY_MS);
}

export function stopPackUpdateChecker(): void {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

async function runUpdateCheck(prewarm: PrewarmFn): Promise<void> {
  checkTimer = setTimeout(() => void runUpdateCheck(prewarm), CHECK_INTERVAL_MS);
  await checkAndUpdatePacks(prewarm);
}

export async function checkAndUpdatePacks(prewarm: PrewarmFn): Promise<void> {
  const installedStates = getAllPackStates();
  if (installedStates.length === 0) {
    if (!getPrefetchStatus().running) {
      console.log('[packUpdater] no packs installed — triggering initial download');
      startPrefetch({ packsOnly: true });
    }
    return;
  }

  const controller = new AbortController();
  try {
    const [indexBuf, indexSig] = await Promise.all([
      fetchJson(PACK_INDEX_URL, controller.signal),
      fetchText(PACK_INDEX_SIG_URL, controller.signal),
    ]);

    if (!verifyManifestSignature(indexBuf, indexSig)) {
      console.warn('[packUpdater] index.json signature invalid');
      return;
    }

    const index = PackIndex.parse(JSON.parse(indexBuf.toString('utf8')));

    const tiersToUpdate: CatalogTier[] = [];
    for (const state of installedStates) {
      const remote = index.tiers.find(t => t.tier === state.tier);
      if (remote && remote.version !== state.version) {
        console.log(`[packUpdater] ${state.tier}: update available v${state.version} → v${remote.version}`);
        tiersToUpdate.push(state.tier);
      }
    }

    if (tiersToUpdate.length === 0) return;

    if (getPrefetchStatus().running) {
      console.log('[packUpdater] prefetch job running — deferring update');
      return;
    }

    console.log(`[packUpdater] installing updates for: ${tiersToUpdate.join(', ')}`);
    await installCatalogPacks(tiersToUpdate, controller.signal, prewarm);
    console.log('[packUpdater] update complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'aborted') console.warn('[packUpdater] update check failed:', msg);
  }
}
