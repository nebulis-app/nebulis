/**
 * "Tonight" has one answer per site: the imaging window (server/lib/imagingWindow.ts), handed out as
 * `getNightWindow(...).imaging`. Planner, Explore, forecast scores, the clear-night alert and the best-months
 * chart all read it, so a site's setting can never move one page and leave another behind.
 *
 * This fails when a server module builds a window of its own from the raw twilight times. A module that
 * legitimately needs a physical twilight time (to show it, or to judge a visual event) goes in the allowlist with
 * the reason, so adding one is a decision somebody sees in review.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '../../server');

/** Raw twilight reads: the NightWindow fields and the SunCalc ones. */
const RAW_TWILIGHT = /\.(nightStart|nightEnd|astronomicalDusk|astronomicalDawn|nauticalDusk|nauticalDawn)\b|\b(?:times|today|next|sunTimes|tomorrowSunTimes)\.(night|nightEnd|nauticalDusk|nauticalDawn)\b/;

const ALLOWED: Record<string, string> = {
  'lib/astroCalc.ts': 'builds NightWindow and its imaging field',
  'lib/imagingWindow.ts': 'resolves the window from the twilight times',
  'lib/nightConditions.ts': 'anchors its own sunset-to-sunrise night, then resolves the window through resolveWindow',
  'lib/forecastCache.ts': 'reports the physical twilight times in `tonight`, which clients show as dusk and dawn',
  'lib/skyEvents.ts': 'judges when a visual sky event can be seen against real darkness, not the imaging window',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'dist' || e.name === 'node_modules' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('imaging window guard', () => {
  it('no server module outside the allowlist reads the raw twilight times', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SERVER)) {
      const rel = path.relative(SERVER, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (RAW_TWILIGHT.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'read `getNightWindow(...).imaging` instead (server/lib/imagingWindow.ts)').toEqual([]);
  });

  it('every allowlisted module still exists, so the list cannot rot', () => {
    for (const rel of Object.keys(ALLOWED)) expect(fs.existsSync(path.join(SERVER, rel)), rel).toBe(true);
  });
});
