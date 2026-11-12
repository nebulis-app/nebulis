// @vitest-environment jsdom
import { describe, it, expect, afterAll } from 'vitest';
import i18n from '../../src/i18n';
import { isSunObject } from '../../src/lib/solarObject';

/** The Sun is imaged by day, so labels that say "night" for other objects say "day" for it (i18next context `sun`). */
const SUN_KEYS: Array<[ns: string, key: string]> = [
  ['library', 'objectMedia.groupBy.night'],
  ['library', 'objectMedia.filters.night'],
  ['library', 'objectMedia.group.noNight'],
  ['library', 'objectMedia.group.across'],
  ['library', 'objectMedia.group.openNight'],
  ['observations', 'observationDetail.nightPanel.title'],
  ['observations', 'observationDetail.conditionsPanel.empty'],
  ['observations', 'observationDetail.telescopeChip.opticsSource.manual'],
  ['observations', 'observationDetail.processedImagesGrid.combinesNights'],
  ['observations', 'observationDetail.page.unmarkProcessedMessage'],
  ['observations', 'observationDetail.uploadProcessedModal.combineMultipleNights'],
  ['observations', 'observationDetail.uploadProcessedModal.whichNightsQuestion'],
];

afterAll(async () => { await i18n.changeLanguage('en'); });

describe('Sun wording', () => {
  for (const lang of ['en', 'de', 'fr', 'es', 'nl']) {
    it(`${lang}: every sun variant exists and differs from the night wording`, async () => {
      await i18n.changeLanguage(lang);
      for (const [ns, key] of SUN_KEYS) {
        const night = i18n.t(key, { ns });
        const day = i18n.t(key, { ns, context: 'sun' });
        expect(day, `${lang} ${key}`).not.toBe(night);
        expect(i18n.exists(`${key}_sun`, { ns }), `${lang} ${key}_sun`).toBe(true);
      }
    });
  }

  it('keeps night wording for every other object', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('objectMedia.groupBy.night', { ns: 'library' })).toBe('Night');
    expect(i18n.t('objectMedia.groupBy.night', { ns: 'library', context: 'sun' })).toBe('Day');
  });

  it('recognizes the Sun by any spelling of its id and nothing else', () => {
    for (const id of ['Sun', 'sun', 'SUN', 'Solar', 'sun_photo']) expect(isSunObject(id.replace('_photo', ''))).toBe(true);
    for (const id of ['Moon', 'M31', 'Sunflower', 'NGC 224']) expect(isSunObject(id)).toBe(false);
  });
});
