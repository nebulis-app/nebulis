/**
 * Keeps the night score a single formula. See internal-doc/night-score.md.
 *
 * nightScoreParity.test.ts proves the two implementations agree today. These
 * checks stop a third one appearing: a new place that averages hourly scores or
 * weighs the weather on its own is how 2.1.2 ended up with two numbers for one
 * night.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function sourceFiles(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'dist' || name === 'node_modules') continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel, exts));
    else if (exts.test(name)) out.push(rel);
  }
  return out;
}

describe('there is one night score', () => {
  it('the server rates every night through nightScore.ts', () => {
    const cache = read('server/lib/forecastCache.ts');
    expect(cache).not.toContain('rateNightConditions');
    expect(cache).toContain('scoreObservingNight(');
    // The logbook stores the same score, not a second opinion.
    const log = read('server/lib/nightConditions.ts');
    expect(log).toContain('scoreNightHours(');
    expect(log).not.toMatch(/rate:\s*\(/);
  });

  it('no other server file weighs the weather into a score', () => {
    // The signature of the night score: cloud weighed at 0.6, or its cloudScore term.
    const offenders = sourceFiles('server', /\.ts$/)
      .filter((f) => f !== 'server/lib/nightScore.ts')
      .filter((f) => /cloud\w*\s*\*\s*0\.6\b|\bcloudScore\b/.test(read(f)));
    expect(offenders, 'a second night-score formula: use server/lib/nightScore.ts').toEqual([]);
  });

  it('only known browser files turn the hourly score into numbers', () => {
    // calculateVisibilityScore is the hourly formula. Showing one hour is fine;
    // averaging hours into a night is scoreNight's job. A new caller means a new
    // place that might be rolling hours up on its own, so add it here only after
    // checking it does not.
    const known = new Set([
      'src/components/forecast/HourDetail.tsx',
      'src/components/forecast/ImagingWindow.tsx',
      'src/components/forecast/NightRibbon.tsx',
      'src/components/forecast/TonightHero.tsx',
      'src/components/planner/ScheduleTimeline.tsx',
      'src/lib/forecastScore.ts',
      'src/lib/plannerNight.ts',
    ]);
    const callers = sourceFiles('src', /\.tsx?$/)
      .filter((f) => /\bcalculateVisibilityScore\(/.test(read(f)))
      .map((f) => relative(ROOT, join(ROOT, f)));
    const unknown = callers.filter((f) => !known.has(f));
    expect(unknown, 'to score a night, call scoreNight (src/lib/plannerNight.ts) instead of averaging hours').toEqual([]);
  });

  it('the hero and the outlook cards take their number and word from the shared engine', () => {
    expect(read('src/components/forecast/TonightHero.tsx')).toContain('scoreNight(');
    const card = read('src/components/forecast/NightOutlookCard.tsx');
    expect(card).toContain('scoreLabel(night.score');
    expect(card).not.toContain('night.rating');
  });
});
