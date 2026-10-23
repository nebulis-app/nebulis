// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatPill } from '../../src/components/forecast/TonightHero';

/**
 * The light-pollution tile is mostly data-fetching, so what is worth pinning
 * here is the contract around it: that every language can describe all nine
 * Bortle classes (the component builds those keys dynamically, so
 * i18nKeys.test.ts cannot see them), and that StatPill still renders the action
 * slot and value colour the tile relies on.
 */
const LANGS = ['en', 'de', 'fr', 'es'] as const;
const LOCALES_DIR = path.join(__dirname, '..', '..', 'src', 'locales');

function tonightHero(lang: string): Record<string, unknown> {
  const json = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, lang, 'forecast.json'), 'utf-8'),
  ) as { tonightHero: Record<string, unknown> };
  return json.tonightHero;
}

const SCALAR_KEYS = [
  'lightPollution',
  'bortleClass',
  'bortleNotSet',
  'bortleNeedsLocation',
  'bortleDetecting',
  'bortleWaiting',
  'bortleFailed',
  'detectLightPollution',
] as const;

describe('light pollution — locale coverage', () => {
  it.each([...LANGS])('%s describes every Bortle class from 1 to 9', (lang) => {
    const bortle = tonightHero(lang).bortle as Record<string, unknown>;
    expect(bortle).toBeDefined();
    for (let n = 1; n <= 9; n += 1) {
      expect(typeof bortle[String(n)], `${lang}: tonightHero.bortle.${n}`).toBe('string');
      expect(String(bortle[String(n)]).length, `${lang}: tonightHero.bortle.${n} is empty`).toBeGreaterThan(0);
    }
    // Nothing beyond 9: the route clamps to the 1-9 range, so a 10th would be
    // dead copy that no code path can reach.
    expect(Object.keys(bortle).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it.each([...LANGS])('%s defines the tile copy', (lang) => {
    const hero = tonightHero(lang);
    for (const key of SCALAR_KEYS) {
      expect(typeof hero[key], `${lang}: tonightHero.${key}`).toBe('string');
      expect(String(hero[key]).length, `${lang}: tonightHero.${key} is empty`).toBeGreaterThan(0);
    }
    // The value is a template, so the interpolation cannot be dropped silently.
    expect(String(hero.bortleClass)).toContain('{{number}}');
  });

  it('keeps the Bortle key set identical across languages', () => {
    const reference = Object.keys(tonightHero('en').bortle as object).sort();
    for (const lang of LANGS) {
      expect(Object.keys(tonightHero(lang).bortle as object).sort(), lang).toEqual(reference);
    }
  });

  it('uses no em dash in the light pollution copy', () => {
    for (const lang of LANGS) {
      const group = tonightHero(lang);
      const strings = [
        ...SCALAR_KEYS.map(k => String(group[k])),
        ...Object.values(group.bortle as Record<string, string>),
      ];
      for (const value of strings) {
        expect(value.includes('—'), `${lang}: "${value}"`).toBe(false);
      }
    }
  });
});

describe('StatPill', () => {
  it('renders the label, value and sub-line', () => {
    const html = renderToStaticMarkup(
      <StatPill icon={<span />} label="Light pollution" value="Bortle 6" sub="Bright suburban sky" />,
    );
    expect(html).toContain('Light pollution');
    expect(html).toContain('Bortle 6');
    expect(html).toContain('Bright suburban sky');
  });

  it('omits the sub-line when there is none', () => {
    const html = renderToStaticMarkup(
      <StatPill icon={<span />} label="Dark hours" value="8.9h" />,
    );
    expect(html).toContain('8.9h');
    expect(html).not.toContain('mt-1.5 text-[0.6875rem]');
  });

  it('renders an action only when one is given', () => {
    const withAction = renderToStaticMarkup(
      <StatPill icon={<span />} label="Light pollution" value="Bortle 4" action={<button type="button">re</button>} />,
    );
    const without = renderToStaticMarkup(
      <StatPill icon={<span />} label="Light pollution" value="Bortle 4" />,
    );
    expect(withAction).toContain('re');
    expect(withAction).toContain('ml-auto');
    expect(without).not.toContain('ml-auto');
  });

  it('takes the value colour from the caller', () => {
    const toned = renderToStaticMarkup(
      <StatPill icon={<span />} label="Light pollution" value="Bortle 9" valueClass="text-red-500" />,
    );
    const plain = renderToStaticMarkup(
      <StatPill icon={<span />} label="Dark hours" value="8.9h" />,
    );
    expect(toned).toContain('text-red-500');
    expect(toned).not.toContain('text-white tabular-nums');
    expect(plain).toContain('text-white');
  });
});
