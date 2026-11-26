/**
 * Alerts: started by the composition root (server/index.ts).
 *
 * Events come from three places:
 *   - imports: writeImportHistory (library/importHistory.ts) emits
 *     `import.finished` / `import.failed` directly;
 *   - the evening clear-night check (clearNight.ts);
 *   - dew warnings, each destination at its own lead time before the dew (dewWarning.ts);
 *   - ISS passes, each destination at its own lead time and minimum altitude (issPass.ts);
 *   - ISS transits of the Moon and the Sun, a day and two hours ahead, within each destination's radius (issTransit.ts);
 *   - the update checker, through onUpdateAvailable (appUpdate/state.ts),
 *     announced once per version.
 */
import { onUpdateAvailable, type UpdateStatus } from '../appUpdate/state.js';
import { startClearNightScheduler } from './clearNight.js';
import { startDewWarningScheduler } from './dewWarning.js';
import { startIssPassScheduler } from './issPass.js';
import { startIssTransitScheduler } from './issTransit.js';
import { emitAlert } from './delivery.js';
import { getAlertState, setAlertState } from './store.js';

const UPDATE_KEY = 'update.lastAnnounced';

export function announceUpdate(status: UpdateStatus): void {
  if (!status.latestVersion || getAlertState<string>(UPDATE_KEY) === status.latestVersion) return;
  setAlertState(UPDATE_KEY, status.latestVersion);
  emitAlert({
    type: 'update.available',
    occurredAt: new Date().toISOString(),
    data: { currentVersion: status.currentVersion, latestVersion: status.latestVersion, notesUrl: status.notesUrl },
  });
}

export function startAlerts(): void {
  onUpdateAvailable(announceUpdate);
  startClearNightScheduler();
  startDewWarningScheduler();
  startIssPassScheduler();
  startIssTransitScheduler();
}
