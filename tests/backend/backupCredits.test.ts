import { describe, it, expect } from 'vitest';
import { BACKUP_CREDITS, DSS2_CREDIT, plateCredit } from '../../server/lib/catalogPack/backupCredits';
import { FALLBACK_SOURCES } from '../../server/lib/skyImageFallback';
import { CREDIT_SOURCES } from '../../server/lib/catalogPack/manifest';

describe('backup plate credits', () => {
  it('has a credit and a license link for every backup source', () => {
    for (const source of FALLBACK_SOURCES) {
      expect(BACKUP_CREDITS[source].credit.length).toBeGreaterThan(20);
      expect(BACKUP_CREDITS[source].licenseUrl).toMatch(/^https:\/\//);
    }
  });

  it('credits a plate to its own survey, and to DSS2 only when it is DSS2', () => {
    expect(plateCredit(null)).toEqual(DSS2_CREDIT);
    expect(plateCredit('skyview')).toEqual(DSS2_CREDIT);
    expect(plateCredit('sdss').credit).toContain('Sloan Digital Sky Survey');
    expect(plateCredit('legacy').credit).toContain('Legacy Imaging Surveys');
    expect(plateCredit('panstarrs').credit).toContain('Pan-STARRS1');
  });

  it('adds no new credit source value, which every released app checks against its own list', () => {
    expect([...CREDIT_SOURCES]).toEqual(['hubble', 'dss2', 'nasa', 'curated', 'vphas']);
  });
});
