import { describe, it, expect } from 'vitest';
import { pickWallCandidate, areaForSize, autoSpan } from '../../server/lib/catalogWall';

describe('pickWallCandidate', () => {
  const processed = [
    { path: 'M31/processed/old.jpg', uploadedAt: '2025-01-01T00:00:00Z', source: 'user' },
    { path: 'M31/processed/new.jpg', uploadedAt: '2026-03-01T00:00:00Z', source: 'user' },
    { path: 'M31/processed/restack.png', uploadedAt: '2026-09-01T00:00:00Z', source: 'dwarf-restack' },
  ];

  it('prefers the user-featured image over everything', () => {
    expect(pickWallCandidate({ featured: 'M31/custom.jpg', processed, telescope: 'M31/stacked.jpg' }))
      .toEqual({ path: 'M31/custom.jpg', kind: 'telescope' });
  });

  it('labels a featured image living under processed/ as processed', () => {
    expect(pickWallCandidate({ featured: 'M31/processed/x.jpg', processed: [], telescope: null })?.kind).toBe('processed');
  });

  it('uses the newest user-processed image, ahead of a newer Dwarf restack', () => {
    expect(pickWallCandidate({ featured: null, processed, telescope: 'M31/stacked.jpg' }))
      .toEqual({ path: 'M31/processed/new.jpg', kind: 'processed' });
  });

  it('falls back to a Dwarf restack, then the telescope image', () => {
    expect(pickWallCandidate({ featured: null, processed: [processed[2]], telescope: 'M31/stacked.jpg' }))
      .toEqual({ path: 'M31/processed/restack.png', kind: 'processed' });
    expect(pickWallCandidate({ featured: null, processed: [], telescope: 'M31/stacked.jpg' }))
      .toEqual({ path: 'M31/stacked.jpg', kind: 'telescope' });
  });

  it('returns null when the user has no picture of their own', () => {
    expect(pickWallCandidate({ featured: null, processed: [], telescope: null })).toBeNull();
  });
});

describe('areaForSize / autoSpan', () => {
  it('maps apparent size to area, with unknown sizes staying small', () => {
    expect(areaForSize(null)).toBe(1);
    expect(areaForSize(8)).toBe(1);
    expect(areaForSize(35)).toBe(2);
    expect(areaForSize(65)).toBe(4);
    expect(areaForSize(190)).toBe(6);
  });

  it('orients by image aspect', () => {
    expect(autoSpan(8, 2)).toEqual({ cols: 1, rows: 1 });
    expect(autoSpan(35, 1.5)).toEqual({ cols: 2, rows: 1 });
    expect(autoSpan(35, 0.7)).toEqual({ cols: 1, rows: 2 });
    expect(autoSpan(65, 0.7)).toEqual({ cols: 2, rows: 2 });
    expect(autoSpan(190, 1.6)).toEqual({ cols: 3, rows: 2 });
    expect(autoSpan(190, 0.6)).toEqual({ cols: 2, rows: 3 });
  });

  it('never boosts for anything but sky size', () => {
    expect(autoSpan(8, 1)).toEqual({ cols: 1, rows: 1 });
  });
});
