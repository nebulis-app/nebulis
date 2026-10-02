/**
 * i18next setup. Resources are bundled as static imports rather than fetched
 * through i18next-http-backend: with five shipped languages (English,
 * German, Spanish, French, Dutch) there is nothing worth a network round trip for.
 * Namespaces are per-feature so a translator can claim one file (see
 * src/locales/CONTRIBUTING-TRANSLATIONS.md); revisit lazy-loading only once
 * a namespace is actually large enough to matter for bundle size.
 *
 * Import this module once, before anything calls useTranslation() — done in
 * main.tsx. Initialization is synchronous (no backend plugin), so no loading
 * state or <Suspense> boundary is needed around it.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enLibrary from './locales/en/library.json';
import enPlanner from './locales/en/planner.json';
import enForecast from './locales/en/forecast.json';
import enObservations from './locales/en/observations.json';
import enCatalogs from './locales/en/catalogs.json';
import enErrors from './locales/en/errors.json';
import enHelp from './locales/en/help.json';
import enOnboarding from './locales/en/onboarding.json';
import deCommon from './locales/de/common.json';
import deSettings from './locales/de/settings.json';
import deLibrary from './locales/de/library.json';
import dePlanner from './locales/de/planner.json';
import deForecast from './locales/de/forecast.json';
import deObservations from './locales/de/observations.json';
import deCatalogs from './locales/de/catalogs.json';
import deErrors from './locales/de/errors.json';
import deHelp from './locales/de/help.json';
import deOnboarding from './locales/de/onboarding.json';
import esCommon from './locales/es/common.json';
import esSettings from './locales/es/settings.json';
import esLibrary from './locales/es/library.json';
import esPlanner from './locales/es/planner.json';
import esForecast from './locales/es/forecast.json';
import esObservations from './locales/es/observations.json';
import esCatalogs from './locales/es/catalogs.json';
import esErrors from './locales/es/errors.json';
import esHelp from './locales/es/help.json';
import esOnboarding from './locales/es/onboarding.json';
import frCommon from './locales/fr/common.json';
import frSettings from './locales/fr/settings.json';
import frLibrary from './locales/fr/library.json';
import frPlanner from './locales/fr/planner.json';
import frForecast from './locales/fr/forecast.json';
import frObservations from './locales/fr/observations.json';
import frCatalogs from './locales/fr/catalogs.json';
import frErrors from './locales/fr/errors.json';
import frHelp from './locales/fr/help.json';
import frOnboarding from './locales/fr/onboarding.json';
import nlCommon from './locales/nl/common.json';
import nlSettings from './locales/nl/settings.json';
import nlLibrary from './locales/nl/library.json';
import nlPlanner from './locales/nl/planner.json';
import nlForecast from './locales/nl/forecast.json';
import nlObservations from './locales/nl/observations.json';
import nlCatalogs from './locales/nl/catalogs.json';
import nlErrors from './locales/nl/errors.json';
import nlHelp from './locales/nl/help.json';
import nlOnboarding from './locales/nl/onboarding.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'nl', label: 'Nederlands' },
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** Matches the 'nebulis-theme' localStorage convention in useTheme.ts. */
export const LANGUAGE_STORAGE_KEY = 'nebulis-language';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        library: enLibrary,
        planner: enPlanner,
        forecast: enForecast,
        observations: enObservations,
        catalogs: enCatalogs,
        errors: enErrors,
        help: enHelp,
        onboarding: enOnboarding,
      },
      de: {
        common: deCommon,
        settings: deSettings,
        library: deLibrary,
        planner: dePlanner,
        forecast: deForecast,
        observations: deObservations,
        catalogs: deCatalogs,
        errors: deErrors,
        help: deHelp,
        onboarding: deOnboarding,
      },
      es: {
        common: esCommon,
        settings: esSettings,
        library: esLibrary,
        planner: esPlanner,
        forecast: esForecast,
        observations: esObservations,
        catalogs: esCatalogs,
        errors: esErrors,
        help: esHelp,
        onboarding: esOnboarding,
      },
      fr: {
        common: frCommon,
        settings: frSettings,
        library: frLibrary,
        planner: frPlanner,
        forecast: frForecast,
        observations: frObservations,
        catalogs: frCatalogs,
        errors: frErrors,
        help: frHelp,
        onboarding: frOnboarding,
      },
      nl: {
        common: nlCommon,
        settings: nlSettings,
        library: nlLibrary,
        planner: nlPlanner,
        forecast: nlForecast,
        observations: nlObservations,
        catalogs: nlCatalogs,
        errors: nlErrors,
        help: nlHelp,
        onboarding: nlOnboarding,
      },
    },
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'settings', 'library', 'planner', 'forecast', 'observations', 'catalogs', 'errors', 'help', 'onboarding'],
    interpolation: {
      escapeValue: false, // React already escapes interpolated values.
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
    returnNull: false,
  });

export default i18n;
