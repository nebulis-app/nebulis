import { describe, it, expect, vi, afterEach } from 'vitest';
import { openMeteoHourly } from '../../server/lib/openMeteo';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('openMeteoHourly', () => {
  it('requests the forecast API with the right query and narrows the payload', async () => {
    const fn = stubFetch({
      timezone: 'America/Denver',
      hourly: {
        time: ['2026-01-15T20:00', '2026-01-15T21:00'],
        cloud_cover: [10, 'bad', null],
        temperature_2m: [-4.2, -5.1],
      },
    });

    const out = await openMeteoHourly(39.74, -104.99, {
      vars: ['cloud_cover', 'temperature_2m'],
      startDate: '2026-01-15',
      endDate: '2026-01-15',
    });

    const url = fn.mock.calls[0][0] as string;
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(url).toContain('latitude=39.74');
    expect(url).toContain('hourly=cloud_cover%2Ctemperature_2m');
    expect(url).toContain('timezone=auto');
    expect(url).toContain('start_date=2026-01-15');

    expect(out).toEqual({
      time: ['2026-01-15T20:00', '2026-01-15T21:00'],
      series: {
        cloud_cover: [10, null, null], // non-number → null
        temperature_2m: [-4.2, -5.1],
      },
      timezone: 'America/Denver',
    });
  });

  it('uses the archive API when archive:true', async () => {
    const fn = stubFetch({ hourly: { time: [] } });
    await openMeteoHourly(1, 2, { vars: ['cloud_cover'], startDate: '2020-01-01', endDate: '2020-01-01', archive: true });
    expect(fn.mock.calls[0][0]).toContain('https://archive-api.open-meteo.com/v1/archive?');
  });

  it('returns null on a non-OK response', async () => {
    stubFetch({}, false);
    expect(await openMeteoHourly(1, 2, { vars: ['cloud_cover'] })).toBeNull();
  });

  it('returns null when the body has no hourly block', async () => {
    stubFetch({ error: true, reason: 'bad' });
    expect(await openMeteoHourly(1, 2, { vars: ['cloud_cover'] })).toBeNull();
  });

  it('gives an empty array for a variable the API did not return', async () => {
    stubFetch({ hourly: { time: ['2026-01-15T00:00'] } });
    const out = await openMeteoHourly(1, 2, { vars: ['cloud_cover'] });
    expect(out?.series.cloud_cover).toEqual([]);
  });
});
