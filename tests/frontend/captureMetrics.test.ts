import { describe, it, expect } from 'vitest';
import { formatDuration, buildCaptureMetrics } from '../../src/lib/captureMetrics';
import type { SessionCaptureSummary, SessionFile } from '../../src/types';

// A t() that echoes its key and options, so assertions say which string was chosen without a locale.
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);
const k = (name: string) => `observationDetail.captureMetrics.${name}`;

const capture = (over: Partial<SessionCaptureSummary>): SessionCaptureSummary => over as SessionCaptureSummary;
const stacked = (over: Record<string, unknown> = {}): SessionFile => ({ fileType: 'stacked', ...over }) as unknown as SessionFile;
const sub = (): SessionFile => ({ fileType: 'sub' }) as unknown as SessionFile;

const build = (over: { capture?: SessionCaptureSummary | null; files?: SessionFile[]; tempUnit?: 'celsius' | 'fahrenheit' }) =>
  buildCaptureMetrics({ capture: over.capture ?? null, files: over.files ?? [], tempUnit: over.tempUnit ?? 'celsius', t });
const byKey = (metrics: ReturnType<typeof build>) => Object.fromEntries(metrics.map(m => [m.key, m]));

describe('formatDuration (seconds)', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [60, '1m'],
    [90, '1m 30s'],
    [750, '12m 30s'],
    [3600, '1h'],
    [12_540, '3h 29m'],
    [12_600, '3h 30m'],
  ])('%i s -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('buildCaptureMetrics', () => {
  it('is empty when there is nothing to report', () => {
    expect(build({})).toEqual([]);
  });

  it('prefers the telescope sidecar over what the filename says', () => {
    const m = byKey(build({
      capture: capture({ framesStacked: 209, exposureSec: 10, integrationSec: 2090, filter: 'LP' }),
      files: [stacked({ frameCount: 100, exposure: '30.0s', filter: 'IRCUT' })],
    }));
    expect(m.frames.value).toBe('209');
    expect(m.exposure.value).toBe('10s');
    expect(m.integration.value).toBe('34m 50s');
    expect(m.filter.value).toBe('LP');
  });

  it('falls back to the stacked filename when there is no sidecar, and derives integration from it', () => {
    const m = byKey(build({ files: [stacked({ frameCount: 100, exposure: '30.0s', filter: 'IRCUT' })] }));
    expect(m.frames.value).toBe('100');
    expect(m.exposure.value).toBe('30s');
    expect(m.integration.value).toBe('50m');
    expect(m.filter.value).toBe(k('irCut'));
  });

  it('shows frames kept out of frames attempted, with a percentage bar capped at 100', () => {
    const m = byKey(build({ capture: capture({ framesStacked: 209, framesTaken: 300 }) }));
    expect(m.frames.hint).toBe(`${k('ofTaken')}:{"count":300}`);
    expect(m.frames.bar).toBe(70);
    expect(byKey(build({ capture: capture({ framesStacked: 50, framesTaken: 40 }) })).frames.bar).toBe(100);
  });

  it('uses the planned count only when nothing says how many were taken', () => {
    const m = byKey(build({ capture: capture({ framesStacked: 10, framesPlanned: 20 }) }));
    expect(m.frames.hint).toBe(`${k('ofPlanned')}:{"count":20}`);
    expect(m.frames.bar).toBe(50);
    const both = byKey(build({ capture: capture({ framesStacked: 10, framesTaken: 25, framesPlanned: 20 }) }));
    expect(both.frames.hint).toBe(`${k('ofTaken')}:{"count":25}`);
  });

  it('draws no bar and no hint when the attempted count is unknown', () => {
    const m = byKey(build({ capture: capture({ framesStacked: 10 }) }));
    expect(m.frames.bar).toBeUndefined();
    expect(m.frames.hint).toBeUndefined();
  });

  it('says "Mixed" for exposure and gain when several runs disagree, rather than dropping them', () => {
    const m = byKey(build({ capture: capture({ runs: 3, exposureSec: null, gain: null, framesStacked: 30 }) }));
    expect(m.exposure.value).toBe(k('mixed'));
    expect(m.gain.value).toBe(k('mixed'));
    expect(byKey(build({ capture: capture({ runs: 1, framesStacked: 30 }) })).exposure).toBeUndefined();
  });

  it('a gain of 0 is a value, not an absence', () => {
    expect(byKey(build({ capture: capture({ gain: 0 }) })).gain.value).toBe('0');
  });

  it('notes the run count only for more than one run', () => {
    const many = byKey(build({ capture: capture({ runs: 2, integrationSec: 600 }) }));
    expect(many.integration.hint).toBe(`${k('runsHint')}:{"count":2}`);
    expect(byKey(build({ capture: capture({ runs: 1, integrationSec: 600 }) })).integration.hint).toBeUndefined();
  });

  it('shows one temperature when the range rounds to a single value, and a range otherwise', () => {
    expect(byKey(build({ capture: capture({ minTempC: 11.6, maxTempC: 12.4 }) })).sensor.value).toBe('12°C');
    expect(byKey(build({ capture: capture({ minTempC: 8, maxTempC: 14 }) })).sensor.value).toBe('8°C to 14°C');
  });

  it('converts temperature to Fahrenheit when asked', () => {
    expect(byKey(build({ capture: capture({ minTempC: 0, maxTempC: 100 }), tempUnit: 'fahrenheit' })).sensor.value).toBe('32°F to 212°F');
  });

  it('omits the sensor when either end of the range is missing', () => {
    expect(byKey(build({ capture: capture({ minTempC: 5 }) })).sensor).toBeUndefined();
  });

  it('counts sub-frames from the files, and omits the cell when there are none', () => {
    expect(byKey(build({ files: [sub(), sub(), sub()] })).subs.value).toBe('3');
    expect(byKey(build({ files: [stacked()] })).subs).toBeUndefined();
  });

  it('gives the cells in a stable order', () => {
    const keys = build({
      capture: capture({ framesStacked: 10, exposureSec: 10, integrationSec: 100, gain: 80, filter: 'LP', minTempC: 1, maxTempC: 2 }),
      files: [sub()],
    }).map(m => m.key);
    expect(keys).toEqual(['integration', 'frames', 'exposure', 'gain', 'filter', 'sensor', 'subs']);
  });
});
