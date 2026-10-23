import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Every collaborator is mocked, so this file touches no DB, disk, or network.
const m = vi.hoisted(() => ({
  getPlannerCatalog: vi.fn(),
  getNightWindow: vi.fn(),
  visibilityWindow: vi.fn(),
  getSettingsData: vi.fn(),
  updateSettingsData: vi.fn(),
  getActiveSite: vi.fn(),
  findCachedMaster: vi.fn(),
  prewarmThumbnails: vi.fn(),
  prefetchSkyImage: vi.fn(),
  purgeJunkFiles: vi.fn(),
  purgeStaleImportTmp: vi.fn(),
  pruneImportLog: vi.fn(),
  prewarmSessionThumbnails: vi.fn(),
  pruneSystemLog: vi.fn(),
  refreshForecastCache: vi.fn(),
  checkAndUpdatePacks: vi.fn(),
  observingNightAnchor: vi.fn(),
}));

vi.mock('../../server/lib/dsoCatalog.js', () => ({ getPlannerCatalog: m.getPlannerCatalog }));
vi.mock('../../server/lib/astroCalc.js', () => ({ getNightWindow: m.getNightWindow, visibilityWindow: m.visibilityWindow }));
vi.mock('../../server/lib/telescopes.js', () => ({ getSettingsData: m.getSettingsData, updateSettingsData: m.updateSettingsData }));
vi.mock('../../server/lib/observingSites.js', () => ({ getActiveSite: m.getActiveSite }));
vi.mock('../../server/lib/catalogPrefetch.js', () => ({ findCachedMaster: m.findCachedMaster, prewarmThumbnails: m.prewarmThumbnails }));
vi.mock('../../server/lib/skyImage.js', () => ({ prefetchSkyImage: m.prefetchSkyImage }));
vi.mock('../../server/lib/library/housekeeping.js', () => ({
  purgeJunkFiles: m.purgeJunkFiles, purgeStaleImportTmp: m.purgeStaleImportTmp, pruneImportLog: m.pruneImportLog,
}));
vi.mock('../../server/lib/library/sessionThumbnailPrewarm.js', () => ({ prewarmSessionThumbnails: m.prewarmSessionThumbnails }));
vi.mock('../../server/lib/systemLog.js', () => ({ pruneSystemLog: m.pruneSystemLog }));
vi.mock('../../server/lib/forecastCache.js', () => ({ refreshForecastCache: m.refreshForecastCache }));
vi.mock('../../server/lib/catalogPack/updater.js', () => ({ checkAndUpdatePacks: m.checkAndUpdatePacks }));
vi.mock('../../server/lib/telescopeFiles.js', () => ({ observingNightAnchor: m.observingNightAnchor }));

import {
  runPlannerNightlyPrefetch,
  triggerNightlyMaintenance,
  isNightlyMaintenanceRunning,
  startPlannerNightlyScheduler,
  stopPlannerNightlyScheduler,
} from '../../server/lib/plannerNightlyPrefetch';

const NIGHT = { nightStart: new Date('2026-10-08T20:00:00Z'), nightEnd: new Date('2026-10-09T04:00:00Z') };
const SITE = { latitude: 40, longitude: -75, minAlt: 20, horizonProfile: null, timezone: 'UTC' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getActiveSite.mockReturnValue(SITE);
  m.observingNightAnchor.mockReturnValue(new Date('2026-10-08T12:00:00Z'));
  m.getNightWindow.mockReturnValue(NIGHT);
  m.getPlannerCatalog.mockReturnValue([]);
  m.prewarmThumbnails.mockResolvedValue(undefined);
});

afterEach(() => {
  stopPlannerNightlyScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runPlannerNightlyPrefetch', () => {
  it('skips without stamping when the site has no coordinates', async () => {
    m.getActiveSite.mockReturnValue({ ...SITE, latitude: null });

    await runPlannerNightlyPrefetch();

    expect(m.getNightWindow).not.toHaveBeenCalled();
    expect(m.updateSettingsData).not.toHaveBeenCalled();
  });

  it('stamps last-run but warms nothing when there is no dark window', async () => {
    m.getNightWindow.mockReturnValue({ nightStart: null, nightEnd: null, nauticalDusk: null, nauticalDawn: null });

    await runPlannerNightlyPrefetch();

    expect(m.getPlannerCatalog).not.toHaveBeenCalled();
    expect(m.updateSettingsData).toHaveBeenCalledWith({ plannerPrefetchLastRun: expect.any(Number) });
  });

  it('falls back to the nautical window when there is no astronomical night', async () => {
    m.getNightWindow.mockReturnValue({ nightStart: null, nightEnd: null, nauticalDusk: NIGHT.nightStart, nauticalDawn: NIGHT.nightEnd });
    m.getPlannerCatalog.mockReturnValue([{ id: 'M31', ra: 0.7, dec: 41 }]);
    m.visibilityWindow.mockReturnValue({ maxAlt: 80, rises: true });

    await runPlannerNightlyPrefetch();

    expect(m.visibilityWindow).toHaveBeenCalledWith(0.7, 41, 40, -75, NIGHT.nightStart, NIGHT.nightEnd, 20, null);
  });

  it('warms only objects that rise above the site minimum altitude', async () => {
    m.getPlannerCatalog.mockReturnValue([
      { id: 'HIGH', ra: 1, dec: 1 }, { id: 'LOW', ra: 2, dec: 2 }, { id: 'NEVER', ra: 3, dec: 3 },
    ]);
    m.visibilityWindow
      .mockReturnValueOnce({ maxAlt: 60, rises: true })
      .mockReturnValueOnce({ maxAlt: 10, rises: true })
      .mockReturnValueOnce({ maxAlt: 60, rises: false });
    m.findCachedMaster.mockReturnValue({ path: '/cache/high.jpg', source: 'dss2' });

    await runPlannerNightlyPrefetch();

    expect(m.prewarmThumbnails).toHaveBeenCalledTimes(1);
    expect(m.prewarmThumbnails).toHaveBeenCalledWith('HIGH', '/cache/high.jpg', 'dss2');
  });

  it('fetches a missing master once and warms it when the fetch succeeds', async () => {
    m.getPlannerCatalog.mockReturnValue([{ id: 'M42', ra: 5.5, dec: -5 }]);
    m.visibilityWindow.mockReturnValue({ maxAlt: 50, rises: true });
    m.findCachedMaster.mockReturnValueOnce(null).mockReturnValueOnce({ path: '/c/m42.jpg', source: 'dss2' });
    m.prefetchSkyImage.mockResolvedValue(true);

    await runPlannerNightlyPrefetch();

    expect(m.prefetchSkyImage).toHaveBeenCalledWith('M42');
    expect(m.prewarmThumbnails).toHaveBeenCalledWith('M42', '/c/m42.jpg', 'dss2');
  });

  it('keeps going after one object throws', async () => {
    m.getPlannerCatalog.mockReturnValue([{ id: 'A', ra: 0, dec: 0 }, { id: 'B', ra: 0, dec: 0 }]);
    m.visibilityWindow.mockReturnValue({ maxAlt: 50, rises: true });
    m.findCachedMaster.mockImplementation((id: string) => {
      if (id === 'A') throw new Error('corrupt cache');
      return { path: '/c/b.jpg', source: 'dss2' };
    });

    await runPlannerNightlyPrefetch();

    expect(m.prewarmThumbnails).toHaveBeenCalledWith('B', '/c/b.jpg', 'dss2');
  });
});

describe('triggerNightlyMaintenance', () => {
  it('runs every task and refuses a second concurrent run', async () => {
    let release!: () => void;
    m.checkAndUpdatePacks.mockReturnValue(new Promise<void>(r => { release = r; }));

    expect(triggerNightlyMaintenance()).toBe(true);
    expect(isNightlyMaintenanceRunning()).toBe(true);
    expect(triggerNightlyMaintenance()).toBe(false);

    release();
    await vi.waitFor(() => expect(isNightlyMaintenanceRunning()).toBe(false));
    expect(m.prewarmSessionThumbnails).toHaveBeenCalledWith('nightly');
    expect(m.pruneSystemLog).toHaveBeenCalledTimes(1);
    expect(m.refreshForecastCache).toHaveBeenCalledTimes(1);
  });

  it('a failing task does not stop the later ones', async () => {
    m.checkAndUpdatePacks.mockRejectedValue(new Error('offline'));
    m.purgeJunkFiles.mockRejectedValue(new Error('EACCES'));

    triggerNightlyMaintenance();
    await vi.waitFor(() => expect(isNightlyMaintenanceRunning()).toBe(false));

    expect(m.refreshForecastCache).toHaveBeenCalledTimes(1);
    expect(m.updateSettingsData).toHaveBeenCalledWith({ nightlyForecastLastRun: expect.any(Number) });
    expect(m.updateSettingsData).not.toHaveBeenCalledWith({ nightlyHousekeepingLastRun: expect.any(Number) });
  });
});

describe('scheduler tick', () => {
  it('does nothing while the master switch is off', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T05:00:00Z') });
    m.getSettingsData.mockReturnValue({ nightlyMaintenanceEnabled: false, plannerPrefetchTime: '03:00', timezone: 'UTC' });

    startPlannerNightlyScheduler();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(m.checkAndUpdatePacks).not.toHaveBeenCalled();
  });

  it('runs once when past the target time, and not again the same day', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T05:00:00Z') });
    m.getSettingsData.mockReturnValue({ nightlyMaintenanceEnabled: true, plannerPrefetchTime: '03:00', timezone: 'UTC' });

    startPlannerNightlyScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(m.checkAndUpdatePacks).toHaveBeenCalledTimes(1);
  });
});
