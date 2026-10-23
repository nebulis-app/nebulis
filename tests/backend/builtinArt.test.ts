import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  BUILTIN_ART_IDS,
  BUILTIN_ART_THEMES,
  builtinArtSvg,
  isBuiltinArtSentinel,
  parseBuiltinArtSentinel,
  parseBuiltinArtTheme,
} from '../../server/lib/library/builtinArt.js';

describe('builtin art sentinel', () => {
  it('accepts only the fixed ids', () => {
    expect(isBuiltinArtSentinel('builtin:folder')).toBe(true);
    expect(parseBuiltinArtSentinel('builtin:starfield')).toBe('starfield');
    expect(isBuiltinArtSentinel('builtin:../../etc/passwd')).toBe(false);
    expect(isBuiltinArtSentinel('builtin:')).toBe(false);
    expect(isBuiltinArtSentinel('catalog-source:dss2')).toBe(false);
    expect(parseBuiltinArtSentinel(null)).toBeNull();
  });

  it('falls back to dark for an unknown theme', () => {
    expect(parseBuiltinArtTheme('night')).toBe('night');
    expect(parseBuiltinArtTheme('neon')).toBe('dark');
    expect(parseBuiltinArtTheme(undefined)).toBe('dark');
  });
});

describe('builtin art rendering', () => {
  it.each(BUILTIN_ART_IDS.flatMap(id => BUILTIN_ART_THEMES.map(theme => [id, theme] as const)))(
    '%s / %s rasterises to a non-empty jpeg',
    async (id, theme) => {
      const out = await sharp(Buffer.from(builtinArtSvg(id, theme))).resize(200, 200).jpeg().toBuffer();
      expect(out.length).toBeGreaterThan(500);
    },
  );

  it('differs between themes', () => {
    expect(builtinArtSvg('folder', 'dark')).not.toBe(builtinArtSvg('folder', 'night'));
  });
});
