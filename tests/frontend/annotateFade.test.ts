import { describe, expect, it } from 'vitest';
import { ESTIMATE_FADE_ZOOM_RATIO, fadesEstimate, zoomRatio } from '../../src/lib/annotateFade';

describe('estimate fade', () => {
  it('fades only an estimate, and only well past fit', () => {
    expect(fadesEstimate('approximate', 1)).toBe(false);
    expect(fadesEstimate('approximate', ESTIMATE_FADE_ZOOM_RATIO)).toBe(false);
    expect(fadesEstimate('approximate', ESTIMATE_FADE_ZOOM_RATIO + 0.01)).toBe(true);
    expect(fadesEstimate('approximate', 8)).toBe(true);
  });

  it('never fades a real position, however far in', () => {
    for (const q of ['solved', 'header', 'unavailable'] as const) expect(fadesEstimate(q, 16)).toBe(false);
  });

  it('measures zoom as a multiple of the fit zoom', () => {
    expect(zoomRatio(0.35, 0.35)).toBe(1);
    expect(zoomRatio(1, 0.35)).toBeCloseTo(2.857, 3);
    expect(zoomRatio(1, 0)).toBe(1);
  });
});
