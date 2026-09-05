import { describe, it, expect } from 'vitest';
import { isWaningPhase, litArea, moonGeometry } from '../../src/lib/moonPhase';

const R = 50;
const DISK = Math.PI * R * R;

describe('moonGeometry', () => {
  it('draws a lit area equal to the reported illumination', () => {
    // The whole point of the construction. An inverted sweep flag still
    // produces a plausible-looking moon, but it renders the complement: a 4%
    // crescent comes out as a 96% gibbous. This catches exactly that.
    for (let pct = 0; pct <= 100; pct += 1) {
      const g = moonGeometry(pct, R);
      expect(litArea(g) / DISK).toBeCloseTo(pct / 100, 10);
    }
  });

  it('vanishes at new moon and fills the disk at full', () => {
    expect(litArea(moonGeometry(0, R))).toBeCloseTo(0, 10);
    expect(litArea(moonGeometry(100, R))).toBeCloseTo(DISK, 10);
  });

  it('collapses the terminator to a straight line at half phase', () => {
    expect(moonGeometry(50, R).terminatorRx).toBeCloseTo(0, 10);
    expect(litArea(moonGeometry(50, R))).toBeCloseTo(DISK / 2, 10);
  });

  it('bulges the terminator toward the lit limb for a crescent and away for a gibbous', () => {
    expect(moonGeometry(4, R).sweep).toBe(0);
    expect(moonGeometry(49, R).sweep).toBe(0);
    expect(moonGeometry(51, R).sweep).toBe(1);
    expect(moonGeometry(96, R).sweep).toBe(1);
  });

  it('clamps illumination outside 0-100', () => {
    expect(moonGeometry(-20, R).fraction).toBe(0);
    expect(moonGeometry(180, R).fraction).toBe(1);
    expect(litArea(moonGeometry(180, R))).toBeCloseTo(DISK, 10);
  });

  it('scales with the requested radius', () => {
    const g = moonGeometry(30, 120);
    expect(litArea(g) / (Math.PI * 120 * 120)).toBeCloseTo(0.3, 10);
  });

  it('emits a closed two-arc path', () => {
    const { path } = moonGeometry(25, R);
    expect(path).toMatch(/^M 0,-50 A 50,50 0 0 1 0,50 A [\d.]+,50 0 0 [01] 0,-50 Z$/);
  });
});

describe('isWaningPhase', () => {
  it('detects the phases lit on the left limb', () => {
    expect(isWaningPhase('Waning Crescent')).toBe(true);
    expect(isWaningPhase('Waning Gibbous')).toBe(true);
    expect(isWaningPhase('Last Quarter')).toBe(true);
  });

  it('leaves waxing phases and the extremes unmirrored', () => {
    expect(isWaningPhase('Waxing Crescent')).toBe(false);
    expect(isWaningPhase('First Quarter')).toBe(false);
    expect(isWaningPhase('Full Moon')).toBe(false);
    expect(isWaningPhase('New Moon')).toBe(false);
    expect(isWaningPhase('')).toBe(false);
  });
});
