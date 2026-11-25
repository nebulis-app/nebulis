import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nebulis-schedule-tz-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { updateSettingsData } from '../../server/lib/telescopes';
import {
  initialScheduleTimeZone,
  isValidTimeZone,
  scheduleTimeZone,
  scheduleTimeZoneInfo,
  serverTimeZone,
} from '../../server/lib/scheduleTimeZone';
import { archiveScheduleTimeZone } from '../../server/lib/archive/archiveScheduler';

afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

beforeEach(() => {
  updateSettingsData({ scheduleTimeZone: '', timezone: '' });
});

describe('the schedule time zone', () => {
  it('is the installation zone when one is chosen, whatever the site says', () => {
    updateSettingsData({ scheduleTimeZone: 'Europe/Paris', timezone: 'America/Chicago' });
    expect(scheduleTimeZoneInfo()).toEqual({ timeZone: 'Europe/Paris', source: 'installation' });
    expect(scheduleTimeZone()).toBe('Europe/Paris');
    // Every scheduler reads it through the archive's helper.
    expect(archiveScheduleTimeZone()).toBe('Europe/Paris');
  });

  it("falls back to the default site's saved zone, then to the server's", () => {
    updateSettingsData({ timezone: 'America/Chicago' });
    expect(scheduleTimeZoneInfo()).toEqual({ timeZone: 'America/Chicago', source: 'site' });
    updateSettingsData({ timezone: '' });
    expect(scheduleTimeZoneInfo()).toEqual({ timeZone: serverTimeZone(), source: 'server' });
  });

  it('ignores a stored zone the runtime does not know', () => {
    updateSettingsData({ scheduleTimeZone: 'Mars/Olympus_Mons', timezone: 'Asia/Tokyo' });
    expect(scheduleTimeZoneInfo()).toEqual({ timeZone: 'Asia/Tokyo', source: 'site' });
  });

  it('knows an IANA zone from anything else', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Paris')).toBe(false);
  });
});

describe('the value an existing install starts with', () => {
  const none = { siteTimeZone: '', latitude: null, longitude: null, envTimeZone: undefined };

  it("keeps the zone the schedules already used: the default site's saved one", () => {
    expect(initialScheduleTimeZone({ ...none, siteTimeZone: 'America/Denver', latitude: 45.65, longitude: 6.32 })).toBe('America/Denver');
  });

  it("finds it from the default site's coordinates when the site has none", () => {
    // A site made from typed-in coordinates, in Savoie.
    expect(initialScheduleTimeZone({ ...none, latitude: 45.654532, longitude: 6.324476 })).toBe('Europe/Paris');
  });

  it("then takes the container's TZ, else stays empty", () => {
    expect(initialScheduleTimeZone({ ...none, envTimeZone: 'Europe/Berlin' })).toBe('Europe/Berlin');
    expect(initialScheduleTimeZone({ ...none, envTimeZone: 'not/a zone' })).toBe('');
    expect(initialScheduleTimeZone(none)).toBe('');
  });
});
