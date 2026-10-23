/**
 * Automatic checks on a catalog picture before it goes into a pack.
 *
 * The pack builder used to trust whatever a scraper returned, so the published
 * packs shipped pictures with baked-in banners, black stepped holes where a
 * mosaic has no data, thin strips of a galaxy's edge, and one star field filed
 * under two different objects. These checks catch those shapes. They are not a
 * judge of whether a picture is good: whether the nebula is actually visible,
 * or the right object is in frame, still needs a person looking at the
 * contact sheet (scripts/catalog-contact-sheet.ts).
 *
 * Calibrated against the 1,150 pictures in the published v3/v2/v5/v2/v1 packs:
 * every problem named below was found there by eye first.
 */
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const IMAGE_PROBLEMS = [
  'notch',     // a solid-colour area with no picture data touching an edge
  'strip',     // too thin to show the object
  'banner',    // a solid red label box (the NASA "New Image" banner)
  'text',      // OCR reads words in the picture
  'blank',     // flat, nothing in it
  'duplicate', // looks the same as another object's picture
  'small',     // narrower than the preferred width (advisory)
] as const;
export type ImageProblem = (typeof IMAGE_PROBLEMS)[number];

/** Problems that keep a picture out of a pack unless an override waives them. */
export const HARD_PROBLEMS: readonly ImageProblem[] = ['notch', 'strip', 'banner', 'text', 'blank', 'duplicate'];

export interface ImageStats {
  width: number;
  height: number;
  /** width / height */
  aspect: number;
  /** Share of the picture that is one solid colour (black, white, a flat tile) in a block touching an edge. */
  blackEdgeShare: number;
  /** Share of the picture taken by one solid-red rectangle (a label box). */
  bannerRedShare: number;
  /** Share of pixels that are blown out to near white (a plate zoomed into a bright core). */
  saturatedShare: number;
  lumMean: number;
  lumSd: number;
  /** How much large-scale brightness variation there is (0 = featureless). */
  structure: number;
  /** 32x32 greyscale thumbnail, base64: compared by `signatureDistance`. */
  signature: string;
}

const CELL = 8;
const FLAT_SIZE = 480;

/** Reads a picture once and measures what the checks need. */
export async function analyzeImage(input: Buffer | string): Promise<ImageStats> {
  const base = sharp(input).flatten({ background: '#000000' });
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Nearest-neighbour keeps exact zeros exact; averaging would blur a hole's
  // edge into grey and hide it.
  const flat = await base.clone()
    .resize(FLAT_SIZE, FLAT_SIZE, { fit: 'inside', kernel: 'nearest', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const fw = flat.info.width;
  const fh = flat.info.height;
  const px = flat.data;

  const cols = Math.floor(fw / CELL);
  const rows = Math.floor(fh / CELL);
  // A "flat" cell is one solid colour: black where a mosaic has no data, white
  // or a block of green where a survey tile is missing. Real sky has grain, so
  // a faint dark tone (1-11) is left alone: a dark plate can be that flat.
  const isBlack = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const first = ((cy * CELL) * fw + cx * CELL) * 3;
      const r0 = px[first], g0 = px[first + 1], b0 = px[first + 2];
      let flat = Math.max(r0, g0, b0) === 0 || Math.max(r0, g0, b0) >= 12;
      for (let y = 0; y < CELL && flat; y++) {
        for (let x = 0; x < CELL; x++) {
          const i = ((cy * CELL + y) * fw + cx * CELL + x) * 3;
          if (px[i] !== r0 || px[i + 1] !== g0 || px[i + 2] !== b0) { flat = false; break; }
        }
      }
      isBlack[cy * cols + cx] = flat ? 1 : 0;
    }
  }
  // Largest black region that touches an edge (flood fill from edge cells).
  const seen = new Uint8Array(cols * rows);
  let biggest = 0;
  for (let start = 0; start < cols * rows; start++) {
    const sx = start % cols;
    const sy = Math.floor(start / cols);
    if (!isBlack[start] || seen[start] || !(sx === 0 || sy === 0 || sx === cols - 1 || sy === rows - 1)) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % cols;
      const y = Math.floor(c / cols);
      for (const n of [x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1, y > 0 ? c - cols : -1, y < rows - 1 ? c + cols : -1]) {
        if (n >= 0 && isBlack[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    biggest = Math.max(biggest, size);
  }
  const blackEdgeShare = cols * rows > 0 ? biggest / (cols * rows) : 0;

  // A label box is solid red AND rectangular. Any red alone would flag a Sun
  // in false colour or a red giant, so only the largest solid-red region counts,
  // and only when it fills most of its own bounding box.
  const redMask = new Uint8Array(fw * fh);
  for (let i = 0, p = 0; i < px.length; i += 3, p++) if (px[i] >= 190 && px[i + 1] <= 45 && px[i + 2] <= 45) redMask[p] = 1;
  let bannerPixels = 0;
  const seenRed = new Uint8Array(fw * fh);
  for (let start = 0; start < redMask.length; start++) {
    if (!redMask[start] || seenRed[start]) continue;
    let area = 0;
    let minX = fw, maxX = 0, minY = fh, maxY = 0;
    const stack = [start];
    seenRed[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      area++;
      const x = c % fw;
      const y = (c - x) / fw;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const n of [x > 0 ? c - 1 : -1, x < fw - 1 ? c + 1 : -1, y > 0 ? c - fw : -1, y < fh - 1 ? c + fw : -1]) {
        if (n >= 0 && redMask[n] && !seenRed[n]) { seenRed[n] = 1; stack.push(n); }
      }
    }
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    // The label's own words cut holes in the red, so the fill threshold is loose; the shape is what separates it from a disk.
    if (area / (boxW * boxH) >= 0.5 && boxW >= 1.8 * boxH) bannerPixels = Math.max(bannerPixels, area);
  }
  const bannerRedShare = bannerPixels / (fw * fh);

  let saturated = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] >= 240 && px[i + 1] >= 225 && px[i + 2] >= 200) saturated++;
  const saturatedShare = saturated / (px.length / 3);

  // 32x32 greyscale for structure, tone and the duplicate signature. A small
  // difference hash was tried first and called every bright object on a black
  // field a copy of every other one.
  const small = await base.clone().greyscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
  let sum = 0;
  for (const v of small) sum += v;
  const lumMean = sum / small.length;
  let sq = 0;
  for (const v of small) sq += (v - lumMean) ** 2;
  const structure = Math.sqrt(sq / small.length);

  const stat = await base.clone().greyscale().stats();
  return {
    width,
    height,
    aspect: height > 0 ? width / height : 0,
    blackEdgeShare,
    bannerRedShare,
    saturatedShare,
    lumMean: stat.channels[0].mean,
    lumSd: stat.channels[0].stdev,
    structure,
    signature: small.toString('base64'),
  };
}

/** Mean brightness difference (0-255) between two pictures' signatures. */
export function signatureDistance(a: string, b: string): number {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  const n = Math.min(x.length, y.length);
  if (n === 0) return 255;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(x[i] - y[i]);
  return sum / n;
}

export interface QualityOptions {
  /** Solar-system and other pictures that are meant to sit on a black field. */
  blackBackgroundOk?: boolean;
  /** Preferred minimum width; narrower pictures get the advisory `small`. */
  preferredWidth?: number;
}

export const THRESHOLDS = {
  /** Edge-touching all-black share above which a mosaic hole is assumed. */
  notchShare: 0.015,
  /** Share of solid red pixels that means a label box. */
  bannerRed: 0.004,
  /** Width over height beyond which a picture is a sliver of the object. */
  maxAspect: 3.0,
  minAspect: 0.33,
  /** Shortest side below which there is not enough picture. */
  minShortSide: 250,
  /** lumSd below which a picture is empty. */
  blankSd: 3,
} as const;

/** Mean brightness difference under which two pictures count as the same. */
export const DUPLICATE_DISTANCE = 0.35;

export function qualityProblems(stats: ImageStats, opts: QualityOptions = {}): ImageProblem[] {
  const out: ImageProblem[] = [];
  if (!opts.blackBackgroundOk && stats.blackEdgeShare >= THRESHOLDS.notchShare) out.push('notch');
  if (Math.min(stats.width, stats.height) < THRESHOLDS.minShortSide || stats.aspect > THRESHOLDS.maxAspect || stats.aspect < THRESHOLDS.minAspect) out.push('strip');
  if (stats.bannerRedShare >= THRESHOLDS.bannerRed) out.push('banner');
  if (stats.lumSd < THRESHOLDS.blankSd) out.push('blank');
  if (stats.width < (opts.preferredWidth ?? 800)) out.push('small');
  return out;
}

/** Id of the first picture in `others` that is the same picture, or null. */
export function findDuplicate(signature: string, others: ReadonlyMap<string, string>, maxDistance = DUPLICATE_DISTANCE): string | null {
  for (const [id, sig] of others) if (signatureDistance(signature, sig) <= maxDistance) return id;
  return null;
}

// ─── Text (needs the tesseract program) ──────────────────────────────────────

let tesseractChecked: boolean | null = null;

/** True when the `tesseract` command is installed. Text checks need it. */
export async function ocrAvailable(): Promise<boolean> {
  if (tesseractChecked !== null) return tesseractChecked;
  try {
    await execFileAsync('tesseract', ['--version']);
    tesseractChecked = true;
  } catch {
    tesseractChecked = false;
  }
  return tesseractChecked;
}

/**
 * Words a picture contains that look like real text: three or more letters,
 * confidently read. Returns [] when tesseract is not installed, so the caller
 * should check `ocrAvailable()` and say the check was skipped.
 */
export async function findText(input: Buffer | string): Promise<string[]> {
  if (!(await ocrAvailable())) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-ocr-'));
  try {
    const file = path.join(dir, 'in.png');
    // Bigger and contrast-stretched finds small overlay text the raw picture hides.
    await sharp(input).flatten({ background: '#000000' })
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .greyscale().normalise().png().toFile(file);
    const { stdout } = await execFileAsync('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { maxBuffer: 16 * 1024 * 1024 });
    const words: string[] = [];
    for (const line of stdout.split('\n').slice(1)) {
      const cols = line.split('\t');
      const conf = Number(cols[10]);
      const text = (cols[11] ?? '').trim();
      const letters = text.replace(/[^A-Za-z]/g, '');
      if (conf >= 70 && letters.length >= 3 && /^[A-Za-z0-9][A-Za-z0-9\-./+:']*$/.test(text)) words.push(text);
    }
    return words;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
