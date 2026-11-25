import fs from 'fs';
import path from 'path';

/**
 * Real ASIAIR headers (tests/fixtures/asiair, see its README) as data and as files.
 *
 * A header is kept exactly as the ASIAIR wrote it. Written as a file, it gets 8 × 8
 * pixels of data instead of the original 3840 × 2160, so a test can put a real-looking
 * frame on disk without carrying 16 MB per frame: only NAXIS1/NAXIS2 change.
 */
export const ASIAIR_FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'asiair');

export const ASIAIR_FRAMES = {
  lightH: 'Light_NGC 6888_180.0s_Bin1_H_gain200_20260912-041308_3deg_-8.0C_0108',
  lightNone: 'Light_NGC 891_150.0s_Bin1_None_gain100_20260924-051013_6deg_-8.0C_0079',
  lightNoGainInName: 'Light_SH2-131_180.0s_Bin1_H_20260808-033034_3deg_0091',
  flat: 'Flat_80.0ms_Bin1_None_gain100_20261108-040910_4deg_-8.0C_0094',
  dark: 'Dark_120.0s_Bin1_Dark_gain100_20260814-213622_2deg_-8.0C_0009',
  bias: 'Bias_5.0s_Bin1_Dark_gain100_20260815-193320_2deg_-8.0C_0010',
} as const;

export type AsiairFrame = keyof typeof ASIAIR_FRAMES;

/** The header's cards, without END. */
export function asiairCards(frame: AsiairFrame): string[] {
  const text = fs.readFileSync(path.join(ASIAIR_FIXTURES_DIR, `${ASIAIR_FRAMES[frame]}.hdr`), 'utf8');
  return text.split('\n').filter(line => line !== '' && line !== 'END');
}

const SIDE = 8;
const BLOCK = 2880;

/**
 * Write the frame as a FITS file under `dir`, named as the ASIAIR named it (`.fit`).
 * `drop` leaves out cards by keyword, `set` replaces or adds `KEYWORD = value` cards,
 * so a test can model a header that lacks a key. Returns the absolute path.
 */
export function writeAsiairFits(
  dir: string,
  frame: AsiairFrame,
  options: { name?: string; drop?: string[]; set?: Record<string, string> } = {},
): string {
  const keyOf = (card: string) => card.slice(0, 8).trim();
  const drop = new Set(options.drop ?? []);
  const cards = asiairCards(frame)
    .filter(card => !drop.has(keyOf(card)) && !(options.set && keyOf(card) in options.set))
    .map(card => {
      const key = keyOf(card);
      if (key === 'NAXIS1' || key === 'NAXIS2') return `${key.padEnd(8)}= ${String(SIDE).padStart(20)} / length of data axis`;
      return card;
    });
  for (const [key, value] of Object.entries(options.set ?? {})) cards.push(`${key.padEnd(8)}= ${value}`);
  cards.push('END');

  const header = cards.map(card => card.padEnd(80).slice(0, 80)).join('');
  const headerBytes = Buffer.alloc(Math.ceil(header.length / BLOCK) * BLOCK, ' ');
  headerBytes.write(header, 'latin1');
  const data = Buffer.alloc(Math.ceil((SIDE * SIDE * 2) / BLOCK) * BLOCK, 0);

  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${options.name ?? ASIAIR_FRAMES[frame]}.fit`);
  fs.writeFileSync(abs, Buffer.concat([headerBytes, data]));
  return abs;
}
