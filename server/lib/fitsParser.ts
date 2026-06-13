/**
 * FITS header parser — reads only the header blocks from a FITS file buffer.
 * Does NOT read pixel data.
 */

export interface FitsHeaderCard {
  key: string;
  value: string | number | boolean | null;
  comment: string;
  raw: string;
}

export interface FitsHeader {
  cards: FitsHeaderCard[];
  values: Record<string, string | number | boolean>;
}

/**
 * Parse FITS header from a Buffer (reads only header, not image data).
 */
export function parseFitsHeader(buffer: Buffer): FitsHeader {
  const cards: FitsHeaderCard[] = [];
  const values: Record<string, string | number | boolean> = {};
  let offset = 0;

  while (offset < buffer.length) {
    for (let i = 0; i < 36; i++) {
      if (offset + 80 > buffer.length) break;

      const raw = buffer.toString('ascii', offset, offset + 80);
      offset += 80;

      const key = raw.substring(0, 8).trim();

      if (key === 'END') {
        return { cards, values };
      }

      if (raw[8] === '=' && key) {
        let valStr = raw.substring(10, 80).trim();
        let comment = '';

        // Extract comment after /
        if (valStr.startsWith("'")) {
          // String value — find closing quote
          const closeQuote = valStr.indexOf("'", 1);
          if (closeQuote > 0) {
            const afterQuote = valStr.substring(closeQuote + 1).trim();
            if (afterQuote.startsWith('/')) {
              comment = afterQuote.substring(1).trim();
            }
            valStr = valStr.substring(1, closeQuote).trim();
          }
          cards.push({ key, value: valStr, comment, raw: raw.trim() });
          values[key] = valStr;
        } else {
          const slashIdx = valStr.indexOf('/');
          if (slashIdx > 0) {
            comment = valStr.substring(slashIdx + 1).trim();
            valStr = valStr.substring(0, slashIdx).trim();
          }

          let value: string | number | boolean;
          if (valStr === 'T') {
            value = true;
          } else if (valStr === 'F') {
            value = false;
          } else {
            const num = parseFloat(valStr);
            value = isNaN(num) ? valStr : num;
          }

          cards.push({ key, value, comment, raw: raw.trim() });
          values[key] = value;
        }
      } else if (key === 'COMMENT' || key === 'HISTORY') {
        cards.push({ key, value: raw.substring(8).trim(), comment: '', raw: raw.trim() });
      }
    }
  }

  return { cards, values };
}

export type SubFrameGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'bad';

export interface SubFrameScore {
  score: number;
  grade: SubFrameGrade;
  flags: string[];
  hfr?: number;
  fwhm?: number;
  stars?: number;
  background?: number;
  exposure?: number;
  temperature?: number;
}

function readNumber(values: Record<string, string | number | boolean>, key: string): number | undefined {
  const v = values[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Score a sub-frame from its FITS header. Baseline score is 70 ("good").
 * Adjustments come from HFR, FWHM, star count, and background level. The
 * final score is clamped to [0, 100] and mapped to a grade.
 */
export function scoreSubFrame(header: FitsHeader): SubFrameScore {
  const v = header.values;
  const flags: string[] = [];
  let score = 70;

  const hfr = readNumber(v, 'HFR');
  const fwhm = readNumber(v, 'FWHM');
  const stars = readNumber(v, 'STARS') ?? readNumber(v, 'STARCOUNT') ?? readNumber(v, 'STARCNT');
  const background = readNumber(v, 'BACKGND') ?? readNumber(v, 'PEDESTAL');
  const exposure = readNumber(v, 'EXPTIME') ?? readNumber(v, 'EXPOSURE');
  const temperature = readNumber(v, 'CCD-TEMP') ?? readNumber(v, 'TEMPERAT') ?? readNumber(v, 'TEMP');

  if (hfr !== undefined) {
    if (hfr <= 2.0) score += 15;
    else if (hfr <= 3.0) score += 5;
    else if (hfr <= 4.0) score += 0;
    else if (hfr <= 5.0) score -= 10;
    else if (hfr <= 6.0) { score -= 15; flags.push('high_hfr'); }
    else { score -= 20; flags.push('very_high_hfr'); }
  }

  if (fwhm !== undefined) {
    if (fwhm <= 3.0) score += 5;
    else if (fwhm <= 5.0) score += 0;
    else if (fwhm <= 8.0) score -= 5;
    else score -= 10;
  }

  if (stars !== undefined) {
    if (stars >= 200) score += 10;
    else if (stars >= 100) score += 5;
    else if (stars >= 50) score += 0;
    else if (stars >= 20) { score -= 5; flags.push('low_stars'); }
    else { score -= 20; flags.push('very_low_stars'); }
  }

  if (background !== undefined && exposure !== undefined && exposure > 0) {
    const bgPerSec = background / exposure;
    if (bgPerSec > 2000) {
      flags.push('high_background');
      score -= 10;
    }
  }

  score = Math.max(0, Math.min(100, score));

  let grade: SubFrameGrade;
  if (score >= 85) grade = 'excellent';
  else if (score >= 70) grade = 'good';
  else if (score >= 55) grade = 'fair';
  else if (score >= 40) grade = 'poor';
  else grade = 'bad';

  const result: SubFrameScore = { score, grade, flags };
  if (hfr !== undefined) result.hfr = hfr;
  if (fwhm !== undefined) result.fwhm = fwhm;
  if (stars !== undefined) result.stars = stars;
  if (background !== undefined) result.background = background;
  if (exposure !== undefined) result.exposure = exposure;
  if (temperature !== undefined) result.temperature = temperature;

  return result;
}

