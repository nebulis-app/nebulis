import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseFitsHeader } from '../../server/lib/fitsParser';

/**
 * Property tests for parseFitsHeader. Pure: no DB, no filesystem.
 *
 * The parser runs synchronously, so a regression of the old infinite loop
 * (short tail + no END card) would hang this file rather than fail it. The
 * bounded-work property below guards the fix structurally instead: the parser
 * can never return more cards than there are whole 80-byte records.
 */

const NUM_RUNS = 200;

const PRINTABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;+-_()[]#@!?%&*<>';

/** Printable ASCII without `'` (the parser does not unescape FITS `''`) and trimmed. */
const textArb = (maxLength: number) =>
  fc
    .array(fc.constantFrom(...PRINTABLE.split('')), { minLength: 0, maxLength })
    .map(chars => chars.join('').trim());

/** A FITS keyword: 1-8 chars of A-Z0-9_-, never a reserved/commentary keyword. */
const keyArb = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')), { maxLength: 7 }),
  )
  .map(([first, rest]) => first + rest.join(''))
  .filter(k => k !== 'END' && k !== 'COMMENT' && k !== 'HISTORY');

type CardValue = string | number | boolean;

const valueArb: fc.Arbitrary<CardValue> = fc.oneof(
  fc.boolean(),
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true, noNegativeZero: true, min: -1e12, max: 1e12 }),
  textArb(30),
// String(-0) is "0", so a generated -0 can never round-trip as -0 (fast-check can still shrink a negative
// double to -0 despite noNegativeZero). That is a property of the encoding, not a parser bug.
).map(v => (typeof v === 'number' && Object.is(v, -0) ? 0 : v));

function formatValue(v: CardValue): string {
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number') return String(v);
  return `'${v}'`;
}

function cardLine(key: string, value: CardValue, comment: string): string {
  let line = `${key.padEnd(8)}= ${formatValue(value)}`;
  if (comment) line += ` / ${comment}`;
  return line.padEnd(80);
}

function headerBuffer(lines: string[], withEnd = true): Buffer {
  const all = withEnd ? [...lines, 'END'.padEnd(80)] : lines;
  const body = all.join('');
  const padded = body.padEnd(Math.ceil(body.length / 2880) * 2880 || 2880);
  return Buffer.from(padded, 'ascii');
}

const cardsArb = fc.uniqueArray(
  fc.record({ key: keyArb, value: valueArb, comment: textArb(20) }),
  { selector: c => c.key, maxLength: 60 },
);

describe('parseFitsHeader - property tests', () => {
  it('never throws and does bounded work on arbitrary bytes of any length', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 6000 }), bytes => {
        const header = parseFitsHeader(Buffer.from(bytes));
        // One card per whole 80-byte record at most: a parser that re-reads
        // records (or spins on a short tail) cannot satisfy this.
        expect(header.cards.length).toBeLessThanOrEqual(Math.floor(bytes.length / 80));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('terminates on arbitrary printable text whose length is not a multiple of 80', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 3000 }).filter(s => s.length % 80 !== 0 && !s.includes('END')),
        text => {
          const header = parseFitsHeader(Buffer.from(text, 'ascii'));
          expect(Array.isArray(header.cards)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trips generated key/value/comment cards', () => {
    fc.assert(
      fc.property(cardsArb, cards => {
        const header = parseFitsHeader(headerBuffer(cards.map(c => cardLine(c.key, c.value, c.comment))));

        expect(header.cards).toHaveLength(cards.length);
        cards.forEach((c, i) => {
          expect(header.cards[i].key).toBe(c.key);
          expect(header.cards[i].value).toStrictEqual(c.value);
          expect(header.cards[i].comment).toBe(c.comment);
          expect(header.values[c.key]).toStrictEqual(c.value);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('stops at END: cards after the END record are never read', () => {
    fc.assert(
      fc.property(cardsArb, cardsArb, (before, after) => {
        const lines = [
          ...before.map(c => cardLine(c.key, c.value, c.comment)),
          'END'.padEnd(80),
          ...after.map(c => cardLine(c.key, c.value, c.comment)),
        ];
        const header = parseFitsHeader(headerBuffer(lines, false));
        expect(header.cards.map(c => c.key)).toEqual(before.map(c => c.key));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a header truncated anywhere (no END) yields a prefix of the full parse', () => {
    fc.assert(
      fc.property(cardsArb, fc.nat(), (cards, cutSeed) => {
        const full = headerBuffer(cards.map(c => cardLine(c.key, c.value, c.comment)));
        const fullCards = parseFitsHeader(full).cards;
        const cut = cards.length === 0 ? 0 : cutSeed % (cards.length * 80);
        const truncated = parseFitsHeader(full.subarray(0, cut)).cards;

        expect(truncated.length).toBe(Math.floor(cut / 80));
        expect(truncated).toEqual(fullCards.slice(0, truncated.length));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic: the same bytes always parse to the same header', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3000 }), bytes => {
        const buf = Buffer.from(bytes);
        expect(parseFitsHeader(buf)).toEqual(parseFitsHeader(Buffer.from(buf)));
      }),
      { numRuns: 100 },
    );
  });
});

describe('parseFitsHeader - truncated-tail regression (audit bug 1)', () => {
  it('returns the whole records before a short tail with no END card', () => {
    const tail = 'SIMPLE  =                    T'.padEnd(80) + 'BITPIX  =                   16'.padEnd(80) + 'NAXIS ';
    const header = parseFitsHeader(Buffer.from(tail, 'ascii'));
    expect(header.values).toEqual({ SIMPLE: true, BITPIX: 16 });
  });

  it('returns an empty header for a buffer shorter than one record', () => {
    expect(parseFitsHeader(Buffer.from('SIMPLE  =    T', 'ascii'))).toEqual({ cards: [], values: {} });
  });
});
