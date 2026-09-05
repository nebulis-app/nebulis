import { describe, it, expect } from 'vitest';
import { parseFitsHeader, scoreSubFrame, type FitsHeader } from '../../server/lib/fitsParser';

// Helper to create a FITS header buffer from key=value pairs
function buildFitsBuffer(entries: Record<string, string | number | boolean>, addEnd = true): Buffer {
  const cards: string[] = [];

  for (const [key, val] of Object.entries(entries)) {
    let card = key.padEnd(8);
    if (typeof val === 'boolean') {
      card += `= ${(val ? 'T' : 'F').padStart(20)}`;
    } else if (typeof val === 'number') {
      card += `= ${String(val).padStart(20)}`;
    } else {
      card += `= '${val}'`.padEnd(22);
    }
    cards.push(card.padEnd(80));
  }

  if (addEnd) {
    cards.push('END'.padEnd(80));
  }

  // Pad to 2880 byte boundary
  const totalChars = cards.join('').length;
  const remainder = totalChars % 2880;
  let padded = cards.join('');
  if (remainder !== 0) {
    padded += ' '.repeat(2880 - remainder);
  }

  return Buffer.from(padded, 'ascii');
}

// ─── parseFitsHeader ────────────────────────────────────────────

describe('parseFitsHeader', () => {
  it('parses basic header cards', () => {
    const buf = buildFitsBuffer({
      SIMPLE: true,
      BITPIX: 16,
      NAXIS: 2,
      NAXIS1: 1936,
      NAXIS2: 1096,
    });
    const header = parseFitsHeader(buf);

    expect(header.values.SIMPLE).toBe(true);
    expect(header.values.BITPIX).toBe(16);
    expect(header.values.NAXIS).toBe(2);
    expect(header.values.NAXIS1).toBe(1936);
    expect(header.values.NAXIS2).toBe(1096);
  });

  it('parses string values', () => {
    const buf = buildFitsBuffer({
      OBJECT: 'M42',
      FILTER: 'IRCUT',
    });
    const header = parseFitsHeader(buf);

    expect(header.values.OBJECT).toBe('M42');
    expect(header.values.FILTER).toBe('IRCUT');
  });

  it('parses boolean values', () => {
    const buf = buildFitsBuffer({
      SIMPLE: true,
      EXTEND: false,
    });
    const header = parseFitsHeader(buf);

    expect(header.values.SIMPLE).toBe(true);
    expect(header.values.EXTEND).toBe(false);
  });

  it('returns cards array with raw text', () => {
    const buf = buildFitsBuffer({ BITPIX: 16 });
    const header = parseFitsHeader(buf);

    // Fixture has exactly one entry (BITPIX) + END. parseFitsHeader excludes
    // END from the cards array, so length is exactly 1. `> 0` would have
    // passed for duplicates or stray cards.
    expect(header.cards).toHaveLength(1);
    expect(header.cards[0].key).toBe('BITPIX');
    expect(header.cards[0].value).toBe(16);
  });

  it('should return empty cards and values when buffer contains only END', () => {
    const buf = Buffer.from('END'.padEnd(2880));
    const header = parseFitsHeader(buf);
    expect(header.cards).toEqual([]);
    expect(header.values).toEqual({});
  });

  it('should parse available cards when buffer lacks END card', () => {
    const buf = buildFitsBuffer({ BITPIX: 16 }, false);
    const header = parseFitsHeader(buf);
    // Should still parse what it can
    expect(header.values.BITPIX).toBe(16);
  });

  it('parses floating point values', () => {
    const buf = buildFitsBuffer({
      EXPTIME: 10.5,
      HFR: 2.34,
    });
    const header = parseFitsHeader(buf);

    expect(header.values.EXPTIME).toBe(10.5);
    expect(header.values.HFR).toBe(2.34);
  });
});

// ─── scoreSubFrame ──────────────────────────────────────────────

describe('scoreSubFrame', () => {
  function makeHeader(values: Record<string, string | number | boolean>): FitsHeader {
    return {
      cards: Object.entries(values).map(([key, value]) => ({
        key,
        value,
        comment: '',
        raw: '',
      })),
      values,
    };
  }

  it('returns baseline score of 70 with no quality metrics', () => {
    const header = makeHeader({ BITPIX: 16, NAXIS: 2 });
    const result = scoreSubFrame(header);

    expect(result.score).toBe(70);
    expect(result.grade).toBe('good');
    expect(result.flags).toEqual([]);
  });

  it('scores excellent with great HFR and many stars', () => {
    const header = makeHeader({
      HFR: 1.5,
      FWHM: 2.5,
      STARS: 300,
      EXPTIME: 10,
    });
    const result = scoreSubFrame(header);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.grade).toBe('excellent');
    expect(result.hfr).toBe(1.5);
    expect(result.fwhm).toBe(2.5);
    expect(result.stars).toBe(300);
  });

  it('scores poor with bad HFR and few stars', () => {
    const header = makeHeader({
      HFR: 7.0,
      STARS: 5,
    });
    const result = scoreSubFrame(header);

    expect(result.score).toBeLessThan(50);
    expect(result.flags).toContain('very_high_hfr');
    expect(result.flags).toContain('very_low_stars');
  });

  it('flags high background', () => {
    const header = makeHeader({
      BACKGND: 25000,
      EXPTIME: 10,
    });
    const result = scoreSubFrame(header);

    expect(result.flags).toContain('high_background');
    expect(result.background).toBe(25000);
  });

  it('extracts exposure from EXPTIME', () => {
    const header = makeHeader({ EXPTIME: 10.5 });
    const result = scoreSubFrame(header);
    expect(result.exposure).toBe(10.5);
  });

  it('extracts exposure from EXPOSURE fallback', () => {
    const header = makeHeader({ EXPOSURE: 15 });
    const result = scoreSubFrame(header);
    expect(result.exposure).toBe(15);
  });

  it('extracts temperature from CCD-TEMP', () => {
    const header = makeHeader({ 'CCD-TEMP': -10.5 });
    const result = scoreSubFrame(header);
    expect(result.temperature).toBe(-10.5);
  });

  it('clamps score to 0-100 range', () => {
    // Many bad factors at once
    const header = makeHeader({
      HFR: 10,
      FWHM: 15,
      STARS: 2,
      BACKGND: 50000,
      EXPTIME: 10,
    });
    const result = scoreSubFrame(header);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.grade).toBe('bad');
  });

  it('clamps score at top end', () => {
    const header = makeHeader({
      HFR: 1.0,
      FWHM: 1.5,
      STARS: 500,
    });
    const result = scoreSubFrame(header);

    // Was `<= 100` only, which would pass for any score in [0, 100] —
    // including 0, which would defeat the point of "clamps at top end".
    // The clamp here means the score *hits* the ceiling exactly.
    expect(result.score).toBe(100);
    expect(result.grade).toBe('excellent');
  });
});

describe('parseFitsHeader — truncated input must terminate', () => {
  // The inner card loop bailed on a short tail WITHOUT advancing `offset`,
  // while the outer `while (offset < buffer.length)` stayed true — so any
  // header with no END card whose length is not a multiple of 80 spun forever
  // and hung the request thread. A partially-copied file off a telescope share
  // reaches this through POST /api/satellite/detect.
  //
  // Every case here would hang the process on the old code; the assertions
  // matter less than the fact that the call returns at all.

  it('returns on a buffer whose length is not a multiple of 80 and has no END', () => {
    const buffer = Buffer.from('SIMPLE  =                    T'.padEnd(80) + 'XX', 'ascii');
    const header = parseFitsHeader(buffer);
    expect(header.values.SIMPLE).toBe(true);
  });

  it('returns on a buffer shorter than a single card', () => {
    expect(parseFitsHeader(Buffer.from('SIMPLE', 'ascii')).cards).toEqual([]);
  });

  it('returns on an empty buffer', () => {
    expect(parseFitsHeader(Buffer.alloc(0)).cards).toEqual([]);
  });

  it('returns on a full 2880-byte block with no END and a ragged tail', () => {
    const block = 'SIMPLE  =                    T'.padEnd(80).repeat(36);
    const header = parseFitsHeader(Buffer.from(block + 'ragged', 'ascii'));
    expect(header.values.SIMPLE).toBe(true);
  });

  it('still parses a well-formed header to its END card', () => {
    const cards = [
      'SIMPLE  =                    T'.padEnd(80),
      'NAXIS1  =                 1920'.padEnd(80),
      'END'.padEnd(80),
    ].join('');
    const header = parseFitsHeader(Buffer.from(cards.padEnd(2880), 'ascii'));
    expect(header.values.NAXIS1).toBe(1920);
  });
});
