import { describe, expect, it } from 'vitest';
import type { AnnotationData, FrameAnnotation } from '../../src/lib/api/annotate';
import {
  annotatedFileName, burnSize, burnSources, matchesGrid, planBurn, ringKind, RING_HEX,
} from '../../src/lib/annotateBurn';
import { placeLabels } from '../../src/lib/annotateLabels';

function ann(over: Partial<FrameAnnotation>): FrameAnnotation {
  return {
    id: 'M31', label: 'Andromeda Galaxy', designation: 'M31', typeCode: 'G', type: 'Galaxy', magnitude: 3.4,
    x: 500, y: 800, r: 100, rTrue: 100, oversized: false, isTarget: false, ...over,
  };
}
function data(annotations: FrameAnnotation[], quality: AnnotationData['quality'] = 'solved'): AnnotationData {
  return { quality, imageWidth: 1000, imageHeight: 1600, annotations } as AnnotationData;
}

describe('planBurn', () => {
  it('scales ring centres and radii onto a picture of another size', () => {
    const plan = planBurn(data([ann({})]), 2000, 3200);
    expect(plan.rings[0]).toMatchObject({ x: 1000, y: 1600, r: 200 });
    expect(plan.labels[0].x).toBeGreaterThan(0);
  });

  it('sizes strokes and text to the picture, not to a screen', () => {
    const small = planBurn(data([ann({})]), 1000, 1600);
    const big = planBurn(data([ann({})]), 2000, 3200);
    expect(big.fontPx / small.fontPx).toBeCloseTo(2, 5);
    expect(big.strokePx / small.strokePx).toBeCloseTo(2, 5);
  });

  it('colours by kind and dashes estimates and oversized objects', () => {
    const plan = planBurn(data([
      ann({ id: 'a', isTarget: true }),
      ann({ id: 'b', typeCode: 'OCl', x: 100, y: 100 }),
      ann({ id: 'c', typeCode: 'HII', oversized: true, x: 900, y: 1500 }),
    ], 'approximate'), 1000, 1600);
    expect(plan.rings.map(r => r.color)).toEqual([RING_HEX.target, RING_HEX.cluster, RING_HEX.nebula]);
    // Dash lengths scale with the stroke: one unit = strokePx / 1.6.
    // Approximate (estimated) solve -> [6u, 4u]; oversized object -> [2u, 7u].
    const u = plan.strokePx / 1.6;
    expect(plan.rings[0].dash).toEqual([6 * u, 4 * u]);
    expect(plan.rings[2].dash).toEqual([2 * u, 7 * u]);
    expect(plan.rings[2].round).toBe(true);
    expect(planBurn(data([ann({})]), 1000, 1600).rings[0].dash).toBeNull();
  });

  it('keeps every label inside the picture', () => {
    const edge = [ann({ x: 5, y: 5, r: 20 }), ann({ id: 'b', x: 995, y: 1595, r: 20, label: 'A very long common name', designation: 'NGC 1' })];
    for (const l of planBurn(data(edge), 1000, 1600).labels) {
      expect(l.x).toBeGreaterThan(0);
      expect(l.y).toBeGreaterThan(0);
      expect(l.y).toBeLessThan(1600);
    }
  });
});

describe('placeLabels', () => {
  it('moves a label that would land on an earlier one', () => {
    const a = ann({ id: 'a' });
    const b = ann({ id: 'b', x: 505 });
    const [p, q] = placeLabels([a, b], 1000, 1600, 20);
    expect(Math.abs(p.y - q.y)).toBeGreaterThanOrEqual(20 * 1.25);
  });
});

describe('ringKind', () => {
  it('ranks the target first, then galaxies and clusters', () => {
    expect(ringKind({ isTarget: true, typeCode: 'G' })).toBe('target');
    expect(ringKind({ isTarget: false, typeCode: 'GPair' })).toBe('galaxy');
    expect(ringKind({ isTarget: false, typeCode: 'GCl' })).toBe('cluster');
    expect(ringKind({ isTarget: false, typeCode: 'EmN' })).toBe('nebula');
  });
});

describe('export helpers', () => {
  it('accepts a picture with the annotated shape and rejects a rotated one', () => {
    const d = data([]);
    expect(matchesGrid(d, 3000, 4800)).toBe(true);
    expect(matchesGrid(d, 4800, 3000)).toBe(false);
    expect(matchesGrid(d, 3000, 4000)).toBe(false);
  });

  it('keeps a picture under the canvas limit and leaves a small one alone', () => {
    expect(burnSize(2000, 3000)).toEqual({ width: 2000, height: 3000 });
    const huge = burnSize(8000, 12000);
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000);
    expect(huge.width / huge.height).toBeCloseTo(8000 / 12000, 2);
  });

  it('names the copy as a JPEG beside the original', () => {
    expect(annotatedFileName('Stacked_30_M42.jpg')).toBe('Stacked_30_M42-annotated.jpg');
    expect(annotatedFileName('img_stacked_all.TIF')).toBe('img_stacked_all-annotated.jpg');
  });

  it('only tries the original when a browser can decode it', () => {
    expect(burnSources({ url: '/o.jpg', name: 'o.jpg' }, '/p')).toEqual(['/o.jpg', '/p']);
    expect(burnSources({ url: '/o.tif', name: 'o.tif' }, '/p')).toEqual(['/p']);
    expect(burnSources(null, null)).toEqual([]);
  });
});
