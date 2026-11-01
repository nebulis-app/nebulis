import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { blockFromText } from '../../src/lib/helpLead';

const words = (s: string) => s.trim().split(/\s+/).length;
const filler = ' Then keep going with more words so that this paragraph is clearly long enough to count as a wall of text for the reader.';

describe('blockFromText', () => {
  it('splits a long body at its first sentence', () => {
    const b = blockFromText('Plan my night builds a schedule from your targets.' + filler + filler);
    expect(b?.lead).toBe('Plan my night builds a schedule from your targets.');
    expect(b?.rest.startsWith('Then keep going')).toBe(true);
  });

  it('leaves a short body plain', () => {
    expect(blockFromText('Short body. Two sentences.')).toBeNull();
  });

  it('returns null for a <Trans>-tagged string instead of mangling it', () => {
    expect(blockFromText('Delete <1>{{name}}</1> now.' + filler + filler)).toBeNull();
  });

  it('returns null when there is no sentence boundary', () => {
    expect(blockFromText('one long run on without any stop ' + filler.replace(/\./g, ',') + filler.replace(/\./g, ','))).toBeNull();
  });

  it('returns null when the first sentence is longer than the cap', () => {
    const long = 'A'.padEnd(260, 'a') + '.';
    expect(blockFromText(long + filler + filler)).toBeNull();
    expect(blockFromText(long + filler + filler, 300)?.lead).toBe(long);
  });

  it('does not split on an arrow, an abbreviation or a lone initial', () => {
    const b = blockFromText('Open Settings → Library, e.g. the first row, then switch it on.' + filler + filler);
    expect(b?.lead).toBe('Open Settings → Library, e.g. the first row, then switch it on.');
    expect(blockFromText('Ask J. Smith about it, then pick one.' + filler + filler)?.lead).toBe('Ask J. Smith about it, then pick one.');
  });

  it('keeps a quoted UI label opening the first sentence', () => {
    const b = blockFromText('"Plan my night" builds a schedule. ' + filler + filler);
    expect(b?.lead).toBe('"Plan my night" builds a schedule.');
  });
});

describe('help.json lead extraction per locale', () => {
  const root = path.resolve(__dirname, '../../src/locales');
  const bodies = (locale: string): string[] => {
    const out: string[] = [];
    const walk = (node: unknown, key: string) => {
      if (typeof node === 'string') {
        if (/(Body|\.a|\.p[12])$/.test(key) && words(node) >= 40) out.push(node);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k);
      }
    };
    walk(JSON.parse(fs.readFileSync(path.join(root, locale, 'help.json'), 'utf8')), '');
    return out;
  };

  // Floors from the 200-character cap measured on 2026-11-01 (en 71/80, de 62/80, fr 69/86, es 67/85, nl 70/78). A cap change that starves a language fails here.
  const floors: Record<string, number> = { en: 0.85, de: 0.75, fr: 0.78, es: 0.75, nl: 0.85 };
  for (const [locale, floor] of Object.entries(floors)) {
    it(`${locale} keeps a bold lead on at least ${Math.round(floor * 100)}% of long bodies`, () => {
      const list = bodies(locale);
      const hits = list.filter(b => blockFromText(b) !== null).length;
      expect(list.length).toBeGreaterThan(50);
      expect(hits / list.length).toBeGreaterThanOrEqual(floor);
    });
  }
});
