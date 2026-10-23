import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  analyzeImage, findDuplicate, ocrAvailable, qualityProblems, signatureDistance, findText, HARD_PROBLEMS,
} from '../../server/lib/catalogPack/imageQuality';

// Pictures are built here rather than read from the published packs so the
// test has no network or fixture dependency. Noise stands in for a star field:
// like a real sky plate it is never an exact, flat black.
async function noise(w: number, h: number, seed: string, patches: Array<{ x: number; y: number; w: number; h: number; rgb: [number, number, number] }> = []): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = 0; i < buf.length; i++) buf[i] = 20 + (next() % 60);
  for (const p of patches) {
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = p.rgb[0]; buf[i + 1] = p.rgb[1]; buf[i + 2] = p.rgb[2];
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('qualityProblems', () => {
  it('passes an ordinary picture', async () => {
    const stats = await analyzeImage(await noise(900, 650, 'ok'));
    expect(qualityProblems(stats).filter(p => HARD_PROBLEMS.includes(p))).toEqual([]);
  });

  it('finds a black hole where a mosaic has no data', async () => {
    const stats = await analyzeImage(await noise(900, 650, 'notch', [{ x: 0, y: 0, w: 300, h: 250, rgb: [0, 0, 0] }]));
    expect(qualityProblems(stats)).toContain('notch');
  });

  it('leaves a planet on a black field alone when the caller says so', async () => {
    const png = await noise(900, 650, 'planet', [{ x: 0, y: 0, w: 900, h: 650, rgb: [0, 0, 0] }, { x: 300, y: 200, w: 300, h: 250, rgb: [200, 160, 120] }]);
    const stats = await analyzeImage(png);
    expect(qualityProblems(stats)).toContain('notch');
    expect(qualityProblems(stats, { blackBackgroundOk: true })).not.toContain('notch');
  });

  it('finds a sliver too thin to show the object', async () => {
    expect(qualityProblems(await analyzeImage(await noise(900, 190, 'strip')))).toContain('strip');
    expect(qualityProblems(await analyzeImage(await noise(600, 600, 'wide-enough')))).not.toContain('strip');
  });

  it('finds a solid red label box', async () => {
    const stats = await analyzeImage(await noise(600, 450, 'banner', [{ x: 20, y: 20, w: 150, h: 40, rgb: [225, 20, 20] }]));
    expect(qualityProblems(stats)).toContain('banner');
  });

  it('does not mistake a red disk (a Sun in false colour) for a label box', async () => {
    const svg = Buffer.from('<svg width="600" height="450"><rect width="100%" height="100%" fill="#14161c"/><circle cx="300" cy="225" r="190" fill="#f01408"/></svg>');
    const stats = await analyzeImage(await sharp(svg).png().toBuffer());
    expect(qualityProblems(stats)).not.toContain('banner');
  });

  it('does not mistake a reddish nebula for a label', async () => {
    const stats = await analyzeImage(await noise(600, 450, 'nebula', [{ x: 100, y: 100, w: 300, h: 200, rgb: [200, 90, 60] }]));
    expect(qualityProblems(stats)).not.toContain('banner');
  });

  it('finds an empty picture and calls a narrow one small', async () => {
    const flat = await sharp({ create: { width: 900, height: 650, channels: 3, background: { r: 40, g: 40, b: 40 } } }).png().toBuffer();
    expect(qualityProblems(await analyzeImage(flat))).toContain('blank');
    expect(qualityProblems(await analyzeImage(await noise(600, 500, 'small')))).toContain('small');
    expect(HARD_PROBLEMS).not.toContain('small');
  });
});

describe('blown-out plates', () => {
  it('measures how much of a picture is burnt to white', async () => {
    const burnt = await analyzeImage(await noise(900, 650, 'burnt', [{ x: 0, y: 0, w: 900, h: 300, rgb: [255, 250, 240] }]));
    const normal = await analyzeImage(await noise(900, 650, 'normal'));
    expect(burnt.saturatedShare).toBeGreaterThan(0.4);
    expect(normal.saturatedShare).toBe(0);
  });
});

describe('duplicates', () => {
  it('sees the same picture again and not a different one', async () => {
    const a = await analyzeImage(await noise(800, 600, 'a'));
    const copy = await analyzeImage(await noise(800, 600, 'a'));
    const other = await analyzeImage(await noise(800, 600, 'b', [{ x: 200, y: 150, w: 400, h: 300, rgb: [240, 240, 240] }]));
    expect(signatureDistance(a.signature, copy.signature)).toBe(0);
    expect(signatureDistance(a.signature, other.signature)).toBeGreaterThan(1);
    expect(findDuplicate(copy.signature, new Map([['M1', a.signature]]))).toBe('M1');
    expect(findDuplicate(other.signature, new Map([['M1', a.signature]]))).toBeNull();
  });
});

const hasOcr = await ocrAvailable();

describe('text', () => {
  it.skipIf(!hasOcr)('reads words written on a picture', async () => {
    const svg = Buffer.from('<svg width="900" height="650"><rect width="100%" height="100%" fill="#101820"/><text x="40" y="320" font-family="Helvetica,Arial" font-size="90" fill="#ffffff">NEW IMAGE</text></svg>');
    const png = await sharp(svg).png().toBuffer();
    expect((await findText(png)).length).toBeGreaterThan(0);
    expect(await findText(await noise(900, 650, 'no-words'))).toEqual([]);
  });
});
