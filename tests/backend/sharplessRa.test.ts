import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { SHARPLESS_CATALOG, sharplessToCatalogEntry } from '../../server/lib/sharplessCatalog';
import { getBaseCatalogEntry } from '../../server/data/catalog';
import { raToHours, raToDegs } from '../../server/lib/astroCalc';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { catalogsRouter } from '../../server/routes/catalogs';

// A bare decimal RA string means HOURS in this codebase. Sharpless data is in
// degrees, and the fallback entry used to pass it through unconverted, so every
// Sharpless RA on the boards (and in anything built from them) was 15x too large.

describe('Sharpless RA is converted to hours like every other catalog entry', () => {
  it('round-trips every entry back to its catalog degrees', () => {
    for (const e of SHARPLESS_CATALOG) {
      const entry = sharplessToCatalogEntry(e, e.id);
      expect(raToHours(entry.ra!), e.id).toBeCloseTo(e.raDeg / 15, 6);
      expect(raToDegs(entry.ra!), e.id).toBeCloseTo(e.raDeg, 4);
      expect(parseFloat(entry.dec!), e.id).toBeCloseTo(e.decDeg, 6);
    }
  });

  it('keeps every lookup inside 0-24 hours, whether the entry is bare or curated', () => {
    for (const e of SHARPLESS_CATALOG) {
      const hours = raToHours(getBaseCatalogEntry(e.id)!.ra!);
      expect(hours, e.id).toBeGreaterThanOrEqual(0);
      expect(hours, e.id).toBeLessThan(24);
    }
  });

  it('serves hours on the Sharpless board', async () => {
    const app = express();
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 't'; req.userId = 'u'; req.userRole = 'admin'; next(); });
    app.use('/catalogs', catalogsRouter);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalogs/sharpless/progress`;
      const body = await (await fetch(url)).json() as { data: { objects: Array<{ id: string; ra: number | null }> } };
      expect(body.data.objects.length).toBeGreaterThan(300);
      for (const o of body.data.objects) {
        if (o.ra == null) continue;
        expect(o.ra, o.id).toBeGreaterThanOrEqual(0);
        expect(o.ra, o.id).toBeLessThan(24);
      }
      // Sh2-282 has no cross-reference or curated record, so the board shows its own
      // catalog position, and that must be hours (Sharpless data is degrees).
      const sh282 = SHARPLESS_CATALOG.find(e => e.id === 'Sh2-282')!;
      expect(body.data.objects.find(o => o.id === 'Sh2-282')!.ra!).toBeCloseTo(sh282.raDeg / 15, 3);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
