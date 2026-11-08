import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { catalogsRouter } from '../../server/routes/catalogs';
import { getBaseCatalogEntry } from '../../server/data/catalog';
import { getById as getDsoById } from '../../server/lib/dsoCatalog';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';
import { RASC_FINEST_IDS } from '../../server/lib/rascCatalog';
import { ABELL_IDS } from '../../server/lib/abellCatalog';
import { BERKELEY_IDS } from '../../server/lib/berkeleyCatalog';

async function progressFor(catalog: string) {
  const app = express();
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/catalogs', catalogsRouter);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalogs/${catalog}/progress`;
    return await (await fetch(url)).json() as {
      data: { total: number; objects: Array<{ id: string; name: string; type: string; ra: number | null; dec: number | null }> };
    };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('catalog metadata', () => {
  it('gives every Abell and Berkeley object a description and a constellation', () => {
    for (const id of [...ABELL_IDS, ...BERKELEY_IDS]) {
      const e = getBaseCatalogEntry(id);
      expect(e?.description?.trim().length, id).toBeGreaterThan(20);
      expect(e?.constellation, id).toBeTruthy();
    }
  });

  it('carries distances for the great majority of the new objects', () => {
    const withDistance = (ids: readonly string[]) => ids.filter(id => getBaseCatalogEntry(id)?.distanceLy != null).length;
    expect(withDistance(ABELL_IDS)).toBeGreaterThan(60);
    expect(withDistance(BERKELEY_IDS)).toBeGreaterThan(75);
  });
});

describe('RASC Finest NGC', () => {
  it('has all 111 object ids and a resolvable catalog entry for each', () => {
    expect(RASC_FINEST_IDS).toHaveLength(111);
    expect(RASC_FINEST_IDS.filter(id => !getBaseCatalogEntry(id))).toEqual([]);
  });

  it('serves the board with a position for every object', async () => {
    const { data } = await progressFor('rasc');
    expect(data.total).toBe(111);
    expect(data.objects).toHaveLength(111);
    expect(data.objects.filter(o => o.ra == null || o.dec == null)).toEqual([]);
  });
});

describe('Abell planetary nebulae', () => {
  it('has the 80 confirmed or possible planetaries', () => {
    expect(ABELL_IDS).toHaveLength(80);
    expect(ABELL_IDS.filter(id => !getBaseCatalogEntry(id))).toEqual([]);
  });

  it('folds the cross-identified Abell numbers onto their NGC/IC/Sharpless records', () => {
    expect(resolveCanonicalId('Abell 21')).toBe('SH2-274');
    expect(resolveCanonicalId('Abell 31')).toBe('SH2-290');
    expect(resolveCanonicalId('Abell 37')).toBe('IC972');
    expect(resolveCanonicalId('Abell 50')).toBe('NGC6742');
    expect(resolveCanonicalId('Abell 81')).toBe('IC1454');
  });

  it('serves the board with a position for every object', async () => {
    const { data } = await progressFor('abell');
    expect(data.total).toBe(80);
    expect(data.objects).toHaveLength(80);
    expect(data.objects.filter(o => o.ra == null || o.dec == null)).toEqual([]);
  });

  it('gives the DSS2 image route a position for a new Abell record', () => {
    const a1 = getDsoById('ABELL1');
    expect(a1?.ra).toBeGreaterThan(0);
    expect(a1?.dec).toBeCloseTo(69.178, 2);
    expect(getDsoById('Abell 1')?.id).toBe('ABELL1');
  });
});

describe('Berkeley open clusters', () => {
  it('has the 89 clusters with usable positions', () => {
    expect(BERKELEY_IDS).toHaveLength(89);
    expect(BERKELEY_IDS.filter(id => !getBaseCatalogEntry(id))).toEqual([]);
  });

  it('folds the cross-identified Berkeley numbers onto their NGC records', () => {
    expect(resolveCanonicalId('Berkeley 16')).toBe('NGC1798');
    expect(resolveCanonicalId('Berkeley 46')).toBe('NGC6791');
    expect(resolveCanonicalId('Berkeley 48')).toBe('NGC6827');
  });

  it('serves the board with a position for every object', async () => {
    const { data } = await progressFor('berkeley');
    expect(data.total).toBe(89);
    expect(data.objects).toHaveLength(89);
    expect(data.objects.filter(o => o.ra == null || o.dec == null)).toEqual([]);
  });

  it('gives the DSS2 image route a position for a new Berkeley record', () => {
    const b1 = getDsoById('BERK1');
    expect(b1?.ra).toBeCloseTo(2.4082202 / 15, 3);
    expect(b1?.dec).toBeCloseTo(60.428, 2);
    expect(getDsoById('Berkeley 1')?.id).toBe('BERK1');
  });
});
