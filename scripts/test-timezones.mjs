#!/usr/bin/env node
/**
 * Runs the time-sensitive test suites with the whole process in other time zones.
 *
 * Nearly every "the app says it's tomorrow" bug passed the normal suite because CI runs in UTC, where UTC and local
 * are the same thing. Running the same tests in Chicago (UTC-5/-6), Auckland (UTC+12/+13) and Kolkata (a half-hour
 * offset) makes that class of bug fail. See the "Time zones" section of the contributor guidelines.
 *
 * Files are picked by what they test (dates, nights, forecasts, planners, zones), so a new date test is included
 * without editing a list here.
 *
 *   node scripts/test-timezones.mjs                       # all three zones
 *   node scripts/test-timezones.mjs --tz America/Chicago  # one zone (CI runs one per job)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ZONES = ['America/Chicago', 'Pacific/Auckland', 'Asia/Kolkata'];
const TIME_SENSITIVE = /timezone|timeZone|TimeZone|\bnight|Night|forecast|Forecast|planner|Planner|rollover|sunset|twilight|getHours|toISOString|dateKey|DateKey|DATE-OBS/;
// Not about time, and slow enough to time out on a small runner.
const SKIP = new Set(['tests/backend/dsoAliasSearch.test.ts']);

function testFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'lab' && name !== 'fixtures') out.push(...testFiles(p));
    } else if (/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const tzArg = process.argv.indexOf('--tz');
const zones = tzArg >= 0 ? [process.argv[tzArg + 1]] : ZONES;
const files = ['tests/backend', 'tests/frontend']
  .flatMap(d => testFiles(join(ROOT, d)))
  .map(p => relative(ROOT, p))
  .filter(p => !SKIP.has(p) && TIME_SENSITIVE.test(readFileSync(join(ROOT, p), 'utf8')))
  .sort();

let failed = [];
for (const tz of zones) {
  console.log(`\n=== TZ=${tz}: ${files.length} time-sensitive test files ===`);
  const run = spawnSync('npx', ['vitest', 'run', ...files], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TZ: tz } });
  if (run.status !== 0) failed.push(tz);
}

if (failed.length) {
  console.error(`\nTime-sensitive tests failed in: ${failed.join(', ')}. They pass in UTC, so suspect a date taken in the wrong zone.`);
  process.exit(1);
}
console.log(`\nTime-sensitive tests passed in ${zones.join(', ')}.`);
