import { describe, it, expect } from 'vitest';
import { indexForecastHours, slotSkyQuality, seeingAdjustment, DEFAULT_MAX_CLOUD_COVER } from '../../server/lib/skyQuality';
import type { ForecastHour } from '../../server/lib/forecastCache';

function hour(time: string, over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time, cloudCover: 0, cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0,
    seeing: 3, transparency: 3, humidity: 50, temperature: 10, dewPoint: 0,
    wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null,
    ...over,
  };
}

const HOURS = indexForecastHours([
  hour('2026-10-14T20:00:00Z', { cloudCover: 10, seeing: 1 }),
  hour('2026-10-14T21:00:00Z', { cloudCover: 20, seeing: 2 }),
  hour('2026-10-14T22:00:00Z', { cloudCover: 90, seeing: 4 }),
  hour('2026-10-14T23:00:00Z', { cloudCover: 100, seeing: 5, temperature: 2, dewPoint: 1 }),
]);

const at = (iso: string) => new Date(iso);

describe('slotSkyQuality', () => {
  it('averages the hours a slot overlaps, weighted by overlap', () => {
    const q = slotSkyQuality(HOURS, at('2026-10-14T20:30:00Z'), at('2026-10-14T21:30:00Z'))!;
    expect(q.cloudCover).toBe(15);
    expect(q.seeing).toBe(1.5);
    expect(q.usable).toBe(true);
    expect(q.dewRisk).toBe(false);
  });

  it('marks slots above the cloud threshold unusable and flags dew risk', () => {
    const q = slotSkyQuality(HOURS, at('2026-10-14T22:00:00Z'), at('2026-10-15T00:00:00Z'))!;
    expect(q.cloudCover).toBe(95);
    expect(q.usable).toBe(false);
    expect(q.dewRisk).toBe(true);
    expect(slotSkyQuality(HOURS, at('2026-10-14T22:00:00Z'), at('2026-10-15T00:00:00Z'), 100)!.usable).toBe(true);
  });

  it('returns null when the forecast covers less than half the slot', () => {
    expect(slotSkyQuality(HOURS, at('2026-10-14T23:30:00Z'), at('2026-10-15T02:00:00Z'))).toBeNull();
    expect(slotSkyQuality(HOURS, at('2026-10-20T20:00:00Z'), at('2026-10-20T21:00:00Z'))).toBeNull();
    expect(slotSkyQuality([], at('2026-10-14T20:00:00Z'), at('2026-10-14T21:00:00Z'))).toBeNull();
  });

  it('uses 60 % as the default threshold', () => {
    expect(DEFAULT_MAX_CLOUD_COVER).toBe(60);
  });
});

describe('seeingAdjustment', () => {
  const good = { cloudCover: 0, seeing: 1, transparency: 2, dewRisk: false, usable: true };
  const poor = { ...good, seeing: 5 };
  it('rewards small targets in steady air and penalises them in poor seeing', () => {
    const galaxy = { majorAxisArcmin: 6, type: 'Spiral Galaxy' };
    expect(seeingAdjustment(good, galaxy)).toBe(16);
    expect(seeingAdjustment(poor, galaxy)).toBe(-16);
  });
  it('barely moves large nebulae and ignores missing seeing', () => {
    const nebula = { majorAxisArcmin: 120, type: 'Emission Nebula' };
    expect(seeingAdjustment(good, nebula)).toBe(4);
    expect(seeingAdjustment({ ...good, seeing: null }, nebula)).toBe(0);
    expect(seeingAdjustment(null, nebula)).toBe(0);
  });
});
