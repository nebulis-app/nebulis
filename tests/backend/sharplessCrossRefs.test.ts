import { describe, it, expect } from 'vitest';
import { SHARPLESS_CATALOG } from '../../server/lib/sharplessCatalog';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';
import { getCatalogEntry } from '../../server/data/catalog';
import { raToHours, decToDegs } from '../../server/lib/astroCalc';
import { LISTED_ROWS as openNgc } from '../../server/lib/dsoCatalogData';

// The Sharpless cross-references are scraped from Wikipedia text. Sh2-1 once came out
// as IC1470 (a Cepheus nebula 120 deg away, really Sh2-156), which put the wrong
// position and image on its board tile and credited Sh2-1 whenever IC1470 was imaged.

const MAX_SEP_DEG = 3;

const POSITIONS = new Map<string, { raDeg: number; decDeg: number }>();
for (const r of openNgc) {
  if (r.ra == null || r.dec == null) continue;
  const pos = { raDeg: r.ra * 15, decDeg: r.dec };
  POSITIONS.set(r.id.toUpperCase().replace(/\s+/g, ''), pos);
  if (r.ngcName) POSITIONS.set(r.ngcName.toUpperCase().replace(/\s+/g, ''), pos);
  if (r.messier != null) POSITIONS.set(`M${r.messier}`, pos);
}

function sepDeg(a: { raDeg: number; decDeg: number }, b: { raDeg: number; decDeg: number }): number {
  const rad = Math.PI / 180;
  const cos = Math.sin(a.decDeg * rad) * Math.sin(b.decDeg * rad)
    + Math.cos(a.decDeg * rad) * Math.cos(b.decDeg * rad) * Math.cos((a.raDeg - b.raDeg) * rad);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / rad;
}

describe('Sharpless cross-references', () => {
  it('only point at objects near the Sharpless position', () => {
    const far: string[] = [];
    for (const e of SHARPLESS_CATALOG) {
      for (const ref of [e.ngcRef, e.messierRef]) {
        if (!ref) continue;
        const pos = POSITIONS.get(ref);
        if (!pos) continue; // OpenNGC doesn't list it (e.g. NGC6820): nothing to compare, not a mismatch
        const sep = sepDeg({ raDeg: e.raDeg, decDeg: e.decDeg }, pos);
        if (sep > MAX_SEP_DEG) far.push(`${e.id} -> ${ref} (${sep.toFixed(1)} deg)`);
      }
    }
    expect(far).toEqual([]);
  });

  it('no longer merges Sh2-1 into IC1470', () => {
    expect(resolveCanonicalId('SH2-1')).toBe('SH2-1');
    expect(resolveCanonicalId('IC1470')).toBe('IC1470');
    // Sh2-1's own position (Scorpius/Ophiuchus, about 16 h), not Cepheus.
    expect(raToHours(getCatalogEntry('SH2-1')!.ra!)).toBeCloseTo(239.71337 / 15, 3);
  });

  it('keeps Sh2-86 and its NGC6820 reference at the same place', () => {
    const sh86 = SHARPLESS_CATALOG.find(e => e.id === 'Sh2-86')!;
    const ngc = getCatalogEntry('NGC6820')!;
    expect(ngc).toBeDefined();
    expect(sepDeg({ raDeg: sh86.raDeg, decDeg: sh86.decDeg }, { raDeg: raToHours(ngc.ra!) * 15, decDeg: decToDegs(ngc.dec!) })).toBeLessThan(MAX_SEP_DEG);
  });
});
