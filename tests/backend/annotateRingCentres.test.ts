import { describe, expect, it } from 'vitest';
import { getById, getPlannerCatalog } from '../../server/lib/dsoCatalog';
import { getAnnotationCatalog, getAnnotationEntry } from '../../server/lib/annotate/ringCentres';
import { annotateFrame } from '../../server/lib/annotate/catalogQuery';
import { approximateWcs } from '../../server/lib/annotate/wcs';

describe('annotation ring centres', () => {
  it('puts both Rosette patches at one centre, off the north-west edge where NGC 2238 sits', () => {
    const a = getAnnotationEntry('NGC2238');
    const b = getAnnotationEntry('NGC2237');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.ra).toBe(b!.ra);
    expect(a!.dec).toBe(b!.dec);
    const raw = getById('NGC2238')!;
    const offsetArcmin = Math.hypot((a!.ra - raw.ra) * 15 * Math.cos((raw.dec * Math.PI) / 180), a!.dec - raw.dec) * 60;
    expect(offsetArcmin).toBeGreaterThan(10);
    expect(offsetArcmin).toBeLessThan(25);
  });

  it('leaves every other entry, and the planner catalog itself, at the catalog position', () => {
    const planner = getPlannerCatalog();
    const annotation = getAnnotationCatalog();
    expect(annotation).toHaveLength(planner.length);
    const moved = planner.filter((e, i) => e.ra !== annotation[i].ra || e.dec !== annotation[i].dec).map(e => e.id);
    expect(moved.sort()).toEqual(['NGC1499', 'NGC2237', 'NGC2238']);
  });

  it('centres the California Nebula ring on the whole nebula, about 25 arcmin west of the catalog position', () => {
    const a = getAnnotationEntry('NGC1499')!;
    const raw = getById('NGC1499')!;
    const offsetArcmin = Math.hypot((a.ra - raw.ra) * 15 * Math.cos((raw.dec * Math.PI) / 180), a.dec - raw.dec) * 60;
    expect(a.ra).toBeLessThan(raw.ra);
    expect(offsetArcmin).toBeGreaterThan(20);
    expect(offsetArcmin).toBeLessThan(35);
  });

  it('draws the Rosette ring on the nebula centre in a frame centred there', () => {
    const c = getAnnotationEntry('NGC2238')!;
    const wcs = approximateWcs({ raDeg: c.ra * 15, decDeg: c.dec, width: 2048, height: 1152, longSideDeg: 3 });
    const ring = annotateFrame(wcs, { targetId: 'NGC2244' }).find(a => a.id === 'NGC2238');
    expect(ring).toBeDefined();
    expect(Math.abs(ring!.x - 1024)).toBeLessThan(2);
    expect(Math.abs(ring!.y - 576)).toBeLessThan(2);
  });
});
