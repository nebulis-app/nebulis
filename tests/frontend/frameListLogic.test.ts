import { describe, it, expect } from 'vitest';
import type { FrameAnalysisRow, FrameFlag, FrameGrade } from '../../src/lib/api/frameAnalysis';
import {
  captureTime, longestGap, orderRows, sharedPrefixLength, summaryOf, timelineTicks,
} from '../../src/components/frameAnalysis/frameListLogic';

function row(name: string, o: { stamp?: string; score?: number; grade?: FrameGrade; flags?: FrameFlag[]; stars?: number; fwhm?: number; round?: number } = {}): FrameAnalysisRow {
  const measured = o.score !== undefined;
  return {
    path: `obj/${name}`,
    name,
    timestamp: o.stamp ?? null,
    thumbUrl: null,
    downloadUrl: '',
    // The list never reads the library record; the cast keeps the fixture small.
    file: {} as FrameAnalysisRow['file'],
    metrics: measured
      ? {
        width: 100, height: 100, starCount: o.stars ?? 100, fwhm: o.fwhm ?? 3, elongation: o.round ?? 1.1, orientation: null,
        background: 1000, noise: 10, gradient: 0, peakSNR: null, streak: null, saturatedFraction: 0, ra: null, dec: null,
      }
      : null,
    verdict: measured
      ? { score: o.score ?? 0, grade: o.grade ?? 'good', flags: o.flags ?? [], reasons: [] }
      : null,
  };
}

describe('captureTime', () => {
  it('reads the telescope stamp as a wall-clock time', () => {
    const d = captureTime('20260418-210530');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getHours()).toBe(21);
    expect(d?.getMinutes()).toBe(5);
    expect(d?.getSeconds()).toBe(30);
  });
  it('answers null when there is no stamp', () => {
    expect(captureTime(null)).toBeNull();
    expect(captureTime('stacked.fits')).toBeNull();
  });
});

describe('orderRows', () => {
  const rows = [
    row('c', { stamp: '20260418-210200', score: 90, stars: 300 }),
    row('a', { stamp: '20260418-210000', score: 40, grade: 'bad', flags: ['clouds'], stars: 80 }),
    row('b', { stamp: '20260418-210100' }), // not measured
    row('d', { stamp: '20260418-210300', score: 70, grade: 'fair', flags: ['trails', 'soft'], stars: 200, round: 1.9 }),
  ];

  it('lists a night in capture order by default, unmeasured frames among the rest', () => {
    const out = orderRows(rows, { sortKey: 'time', ascending: true, flaggedOnly: false });
    expect(out.map(r => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('puts unmeasured frames last whichever way a measured column runs', () => {
    const up = orderRows(rows, { sortKey: 'score', ascending: true, flaggedOnly: false }).map(r => r.name);
    const down = orderRows(rows, { sortKey: 'score', ascending: false, flaggedOnly: false }).map(r => r.name);
    expect(up).toEqual(['a', 'd', 'c', 'b']);
    expect(down).toEqual(['c', 'd', 'a', 'b']);
  });

  it('sorts by how much is wrong: worse grade first, then more flags', () => {
    const out = orderRows(rows, { sortKey: 'flags', ascending: true, flaggedOnly: false }).map(r => r.name);
    expect(out.slice(0, 3)).toEqual(['a', 'd', 'c']);
  });

  it('keeps only flagged or bad frames when asked', () => {
    const out = orderRows(rows, { sortKey: 'time', ascending: true, flaggedOnly: true }).map(r => r.name);
    expect(out).toEqual(['a', 'd']);
  });

  it('sorts file names the way a person counts', () => {
    const named = [row('Light_10.fit'), row('Light_2.fit'), row('Light_1.fit')];
    expect(orderRows(named, { sortKey: 'file', ascending: true, flaggedOnly: false }).map(r => r.name))
      .toEqual(['Light_1.fit', 'Light_2.fit', 'Light_10.fit']);
  });
});

describe('summaryOf', () => {
  it('counts a frame once when it is both bad and flagged', () => {
    const s = summaryOf([
      row('a', { score: 30, grade: 'bad', flags: ['clouds'] }),
      row('b', { score: 70, grade: 'fair', flags: ['streak'] }),
      row('c', { score: 95 }),
      row('d'),
    ]);
    expect(s.flagged).toBe(2);
    expect(s.bad).toBe(1);
    expect(s.badPaths).toEqual(['obj/a']);
    expect(s.flaggedPaths).toEqual(['obj/a', 'obj/b']);
  });
});

describe('longestGap', () => {
  const at = (s: number) => {
    const t = new Date(2026, 3, 18, 21, 0, 0).getTime() + s * 1000;
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  it('finds a pause that is both long and out of step with the rest', () => {
    const stamps = [0, 10, 20, 30, 40, 700, 710, 720].map(at);
    const gap = longestGap(stamps.map((s, i) => row(`f${i}`, { stamp: s })));
    expect(gap?.seconds).toBe(660);
  });

  it('says nothing for an even night or a short one', () => {
    const even = [0, 10, 20, 30, 40, 50].map(at).map((s, i) => row(`f${i}`, { stamp: s }));
    expect(longestGap(even)).toBeNull();
    expect(longestGap([row('a', { stamp: at(0) }), row('b', { stamp: at(900) })])).toBeNull();
  });
});

describe('sharedPrefixLength', () => {
  it('trims what every file of a night shares, at a separator', () => {
    const names = ['Light_M 51_10.0s_IRCUT_20260418-210000.fit', 'Light_M 51_10.0s_IRCUT_20260418-210010.fit'];
    const n = sharedPrefixLength(names);
    // Backed up to the separator before the digits that differ, so a number is never cut in half.
    expect(names[0].slice(0, n)).toBe('Light_M 51_10.0s_IRCUT_20260418-');
    expect(names[0].slice(n)).toBe('210000.fit');
  });
  it('leaves a lone name or an uneven set alone', () => {
    expect(sharedPrefixLength(['a.fit'])).toBe(0);
    expect(sharedPrefixLength(['abc.fit', 'xyz.fit'])).toBe(0);
  });
});

describe('timelineTicks', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime();

  it('puts round times between the ends of a ten minute night, none on top of the end labels', () => {
    const ticks = timelineTicks(at(22, 19), at(22, 29));
    expect(ticks.map(t => new Date(t.at).getMinutes())).toEqual([20, 22, 24, 26, 28]);
    for (const t of ticks) expect(t.fraction).toBeGreaterThan(0.07);
  });

  it('steps by the half hour or hour over a long night', () => {
    const ticks = timelineTicks(at(21, 5), at(23, 50));
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.every(t => new Date(t.at).getMinutes() % 30 === 0)).toBe(true);
  });

  it('adds none when the span is under three minutes or empty', () => {
    expect(timelineTicks(at(22, 0), at(22, 2))).toEqual([]);
    expect(timelineTicks(at(22, 0), at(22, 0))).toEqual([]);
  });
});
