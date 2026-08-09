import { describe, it, expect } from 'vitest';
import { OBSERVING_NIGHT_ROLLOVER_HOUR } from '../../server/lib/telescopeFiles.js';
import { NIGHT_ROLLOVER_HOUR } from '../../src/lib/nightWindow';

// The observing-night rollover hour is duplicated across five places that
// can't share a single import: this backend constant, the frontend's own
// copy (browser code, can't reach into a server-only module), NightDate.swift
// (iOS), and PlannerTime.kt (Android). A silent drift between any of them
// would misattribute sessions near the rollover to the wrong night on
// whichever surface fell out of sync. This test can only reach the two
// TypeScript copies that share this repo and test runner — the native
// clients' copies need checking by hand if this value ever changes.
describe('observing-night rollover hour stays in sync', () => {
  it('backend and frontend copies agree', () => {
    expect(NIGHT_ROLLOVER_HOUR).toBe(OBSERVING_NIGHT_ROLLOVER_HOUR);
  });

  it('is 7 (the documented, deliberately-chosen value)', () => {
    expect(OBSERVING_NIGHT_ROLLOVER_HOUR).toBe(7);
  });
});
