import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_RETRY_DAYS,
  isEnrichmentCoolingDown,
} from '../../server/lib/library/enrichmentCooldown';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('enrichment cooldown', () => {
  it('lets an object that has never been looked up through', () => {
    expect(isEnrichmentCoolingDown(null, 0, NOW)).toBe(false);
    expect(isEnrichmentCoolingDown(undefined, undefined, NOW)).toBe(false);
  });

  it('holds off a first miss for a day, then retries', () => {
    expect(isEnrichmentCoolingDown(ago(2 * 60 * 60 * 1000), 1, NOW)).toBe(true);
    expect(isEnrichmentCoolingDown(ago(2 * DAY), 1, NOW)).toBe(false);
  });

  it('backs off further with each repeated miss', () => {
    // Two attempts: a 2-day-old lookup is still inside the 7-day window that a
    // single attempt would already have cleared.
    expect(isEnrichmentCoolingDown(ago(2 * DAY), 2, NOW)).toBe(true);
    expect(isEnrichmentCoolingDown(ago(10 * DAY), 2, NOW)).toBe(false);
    // Three attempts moves it to the 30-day step, where 10 days is still early.
    expect(isEnrichmentCoolingDown(ago(10 * DAY), 3, NOW)).toBe(true);
    expect(isEnrichmentCoolingDown(ago(40 * DAY), 3, NOW)).toBe(false);
  });

  it('caps the backoff at the last step rather than growing without bound', () => {
    const past = ENRICHMENT_RETRY_DAYS[ENRICHMENT_RETRY_DAYS.length - 1] + 1;
    expect(isEnrichmentCoolingDown(ago(past * DAY), 99, NOW)).toBe(false);
  });

  it('treats an unparseable or future timestamp as no cooldown', () => {
    // A clock that moved backwards must not freeze enrichment indefinitely.
    expect(isEnrichmentCoolingDown('not a date', 1, NOW)).toBe(false);
    expect(isEnrichmentCoolingDown(new Date(NOW + 5 * DAY).toISOString(), 1, NOW)).toBe(false);
  });
});
