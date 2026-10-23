/**
 * Human text for an alert, in the language chosen in the alert options.
 *
 * The server has no i18n framework (the web client's locale files are bundled
 * into the SPA), and alerts are a handful of short sentences, so the strings
 * live here, one table per language. Every table has the same keys; the
 * parity test in tests/backend/alertMessages.test.ts keeps it that way.
 */
import type { AlertDetails, AlertEvent, AlertLanguage, ClearNightAlertData, ImportAlertData } from './types.js';

export interface AlertMessage {
  title: string;
  body: string;
  /** Where a tap on a phone's notification lands, when this message wants somewhere other than the event's usual place. */
  deepLink?: string | null;
  /** Short tags for ntfy (rendered as emoji or labels there). */
  tags: string[];
  /** A link worth opening, when there is one. */
  url: string | null;
  /**
   * The first line of `body`, set when it is the answer a person wants at a glance. A phone shows it under the title, in larger type, and
   * leaves the rest of `body` below; every other channel still gets the whole body.
   */
  lead: string | null;
}

type Vars = Record<string, string | number>;

const STRINGS = {
  en: {
    importFinishedTitle: 'Import finished',
    importFinishedBody: '{count} new files from {origin}: {objects}',
    importFinishedNoObjects: '{count} new files from {origin}',
    importFailedTitle: 'Import failed',
    importFailedBody: '{origin}: {error}',
    originFolder: 'a local folder',
    originTelescope: 'the telescope',
    more: '+{count} more',
    clearTitle: 'Clear tonight: {site}',
    clearAllNight: 'All night, {start} to {end}',
    clearPartial: '{clear} of {dark} clear, best {start} to {end}',
    clearMoon: 'Moon {illum}%, down for {down}',
    clearMoonUp: 'Moon {illum}%, up the whole time',
    clearConditions: 'Seeing {label}, clouds up to {pct}%',
    clearClouds: 'Clouds up to {pct}%',
    clearMoonSets: 'Moon {illum}%, sets {time}',
    clearMoonRises: 'Moon {illum}%, rises {time}',
    clearMoonNone: 'Moon {illum}%, no interference',
    clearDewLikely: 'Dew likely from {time}, low {temp}',
    clearDewPossible: 'Dew possible from {time}, low {temp}',
    clearDewNone: 'No dew expected, low {temp}',
    clearPlan: 'Planned: {objects}',
    clearPlanNone: 'Nothing planned. Tap to plan.',
    dewTitle: 'Dew warning: {site}',
    dewLikely: 'Dew likely from {time}',
    dewPossible: 'Dew possible from {time}',
    dewLow: 'Low {temp} tonight',
    seeing1: 'excellent', seeing2: 'good', seeing3: 'average', seeing4: 'poor', seeing5: 'bad',
    updateTitle: 'Nebulis {version} is available',
    updateBody: 'You are running {current}.',
    testTitle: 'Nebulis test alert',
    testBody: 'If you can read this, alerts to this channel work.',
    decimal: '.',
  },
  fr: {
    importFinishedTitle: 'Import terminé',
    importFinishedBody: '{count} nouveaux fichiers depuis {origin} : {objects}',
    importFinishedNoObjects: '{count} nouveaux fichiers depuis {origin}',
    importFailedTitle: "Échec de l'import",
    importFailedBody: '{origin} : {error}',
    originFolder: 'un dossier local',
    originTelescope: 'le télescope',
    more: 'et {count} autres',
    clearTitle: 'Nuit dégagée ce soir : {site}',
    clearAllNight: 'Toute la nuit, de {start} à {end}',
    clearPartial: '{clear} dégagées sur {dark}, meilleur créneau de {start} à {end}',
    clearMoon: 'Lune à {illum} %, sous l’horizon pendant {down}',
    clearMoonUp: 'Lune à {illum} %, levée pendant tout ce temps',
    clearConditions: 'Seeing {label}, nuages jusqu’à {pct} %',
    clearClouds: 'Nuages jusqu’à {pct} %',
    clearMoonSets: 'Lune à {illum} %, se couche à {time}',
    clearMoonRises: 'Lune à {illum} %, se lève à {time}',
    clearMoonNone: 'Lune à {illum} %, sans gêne',
    clearDewLikely: 'Rosée probable dès {time}, minimum {temp}',
    clearDewPossible: 'Rosée possible dès {time}, minimum {temp}',
    clearDewNone: 'Pas de rosée prévue, minimum {temp}',
    clearPlan: 'Prévu : {objects}',
    clearPlanNone: 'Rien de prévu. Touchez pour planifier.',
    dewTitle: 'Alerte rosée : {site}',
    dewLikely: 'Rosée probable dès {time}',
    dewPossible: 'Rosée possible dès {time}',
    dewLow: 'Minimum {temp} cette nuit',
    seeing1: 'excellent', seeing2: 'bon', seeing3: 'moyen', seeing4: 'médiocre', seeing5: 'mauvais',
    updateTitle: 'Nebulis {version} est disponible',
    updateBody: 'Version installée : {current}.',
    testTitle: 'Alerte de test Nebulis',
    testBody: 'Si vous lisez ceci, les alertes vers ce canal fonctionnent.',
    decimal: ',',
  },
  de: {
    importFinishedTitle: 'Import abgeschlossen',
    importFinishedBody: '{count} neue Dateien von {origin}: {objects}',
    importFinishedNoObjects: '{count} neue Dateien von {origin}',
    importFailedTitle: 'Import fehlgeschlagen',
    importFailedBody: '{origin}: {error}',
    originFolder: 'einem lokalen Ordner',
    originTelescope: 'dem Teleskop',
    more: '+{count} weitere',
    clearTitle: 'Klare Nacht heute: {site}',
    clearAllNight: 'Die ganze Nacht, {start} bis {end}',
    clearPartial: '{clear} von {dark} klar, am besten {start} bis {end}',
    clearMoon: 'Mond {illum} %, unter dem Horizont für {down}',
    clearMoonUp: 'Mond {illum} %, die ganze Zeit über dem Horizont',
    clearConditions: 'Seeing {label}, Bewölkung bis {pct} %',
    clearClouds: 'Bewölkung bis {pct} %',
    clearMoonSets: 'Mond {illum} %, geht um {time} unter',
    clearMoonRises: 'Mond {illum} %, geht um {time} auf',
    clearMoonNone: 'Mond {illum} %, stört kaum',
    clearDewLikely: 'Tau wahrscheinlich ab {time}, Tiefstwert {temp}',
    clearDewPossible: 'Tau möglich ab {time}, Tiefstwert {temp}',
    clearDewNone: 'Kein Tau erwartet, Tiefstwert {temp}',
    clearPlan: 'Geplant: {objects}',
    clearPlanNone: 'Nichts geplant. Zum Planen tippen.',
    dewTitle: 'Tauwarnung: {site}',
    dewLikely: 'Tau wahrscheinlich ab {time}',
    dewPossible: 'Tau möglich ab {time}',
    dewLow: 'Tiefstwert {temp} heute Nacht',
    seeing1: 'ausgezeichnet', seeing2: 'gut', seeing3: 'mittel', seeing4: 'schlecht', seeing5: 'sehr schlecht',
    updateTitle: 'Nebulis {version} ist verfügbar',
    updateBody: 'Installiert ist {current}.',
    testTitle: 'Nebulis-Testalarm',
    testBody: 'Wenn Sie dies lesen, funktionieren Alarme an diesen Kanal.',
    decimal: ',',
  },
  es: {
    importFinishedTitle: 'Importación terminada',
    importFinishedBody: '{count} archivos nuevos desde {origin}: {objects}',
    importFinishedNoObjects: '{count} archivos nuevos desde {origin}',
    importFailedTitle: 'La importación falló',
    importFailedBody: '{origin}: {error}',
    originFolder: 'una carpeta local',
    originTelescope: 'el telescopio',
    more: 'y {count} más',
    clearTitle: 'Noche despejada hoy: {site}',
    clearAllNight: 'Toda la noche, de {start} a {end}',
    clearPartial: '{clear} despejadas de {dark}, mejor de {start} a {end}',
    clearMoon: 'Luna al {illum} %, bajo el horizonte durante {down}',
    clearMoonUp: 'Luna al {illum} %, sobre el horizonte todo el tiempo',
    clearConditions: 'Seeing {label}, nubes hasta {pct} %',
    clearClouds: 'Nubes hasta {pct} %',
    clearMoonSets: 'Luna al {illum} %, se pone a las {time}',
    clearMoonRises: 'Luna al {illum} %, sale a las {time}',
    clearMoonNone: 'Luna al {illum} %, sin interferencia',
    clearDewLikely: 'Rocío probable desde las {time}, mínima {temp}',
    clearDewPossible: 'Rocío posible desde las {time}, mínima {temp}',
    clearDewNone: 'Sin rocío previsto, mínima {temp}',
    clearPlan: 'Planificado: {objects}',
    clearPlanNone: 'Nada planificado. Toca para planificar.',
    dewTitle: 'Aviso de rocío: {site}',
    dewLikely: 'Rocío probable desde las {time}',
    dewPossible: 'Rocío posible desde las {time}',
    dewLow: 'Mínima de {temp} esta noche',
    seeing1: 'excelente', seeing2: 'bueno', seeing3: 'medio', seeing4: 'malo', seeing5: 'muy malo',
    updateTitle: 'Nebulis {version} está disponible',
    updateBody: 'Versión instalada: {current}.',
    testTitle: 'Alerta de prueba de Nebulis',
    testBody: 'Si puede leer esto, las alertas a este canal funcionan.',
    decimal: ',',
  },
  nl: {
    importFinishedTitle: 'Import voltooid',
    importFinishedBody: '{count} nieuwe bestanden van {origin}: {objects}',
    importFinishedNoObjects: '{count} nieuwe bestanden van {origin}',
    importFailedTitle: 'Import mislukt',
    importFailedBody: '{origin}: {error}',
    originFolder: 'een lokale map',
    originTelescope: 'de telescoop',
    more: '+{count} meer',
    clearTitle: 'Heldere nacht vanavond: {site}',
    clearAllNight: 'De hele nacht, {start} tot {end}',
    clearPartial: '{clear} van {dark} helder, het best van {start} tot {end}',
    clearMoon: 'Maan {illum}%, onder de horizon gedurende {down}',
    clearMoonUp: 'Maan {illum}%, de hele tijd boven de horizon',
    clearConditions: 'Seeing {label}, bewolking tot {pct}%',
    clearClouds: 'Bewolking tot {pct}%',
    clearMoonSets: 'Maan {illum}%, gaat onder om {time}',
    clearMoonRises: 'Maan {illum}%, komt op om {time}',
    clearMoonNone: 'Maan {illum}%, geen hinder',
    clearDewLikely: 'Dauw waarschijnlijk vanaf {time}, laagste {temp}',
    clearDewPossible: 'Dauw mogelijk vanaf {time}, laagste {temp}',
    clearDewNone: 'Geen dauw verwacht, laagste {temp}',
    clearPlan: 'Gepland: {objects}',
    clearPlanNone: 'Niets gepland. Tik om te plannen.',
    dewTitle: 'Dauwwaarschuwing: {site}',
    dewLikely: 'Dauw waarschijnlijk vanaf {time}',
    dewPossible: 'Dauw mogelijk vanaf {time}',
    dewLow: 'Laagste temperatuur {temp} vannacht',
    seeing1: 'uitstekend', seeing2: 'goed', seeing3: 'gemiddeld', seeing4: 'slecht', seeing5: 'zeer slecht',
    updateTitle: 'Nebulis {version} is beschikbaar',
    updateBody: 'Geïnstalleerd: {current}.',
    testTitle: 'Nebulis-testmelding',
    testBody: 'Als je dit leest, werken meldingen naar dit kanaal.',
    decimal: ',',
  },
} satisfies Record<AlertLanguage, Record<string, string>>;

export type AlertStringKey = keyof (typeof STRINGS)['en'];
export const _alertStringsForTests = STRINGS;

function fill(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** "5 h", "4.5 h" / "4,5 h". */
export function formatHours(hours: number, lang: AlertLanguage): string {
  const rounded = Math.round(hours * 2) / 2;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', STRINGS[lang].decimal);
  return `${text} h`;
}

/** 24-hour local time, the same for every language: "22:30". */
export function formatClock(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

const MAX_LISTED_OBJECTS = 5;

function importOrigin(d: ImportAlertData, s: (typeof STRINGS)[AlertLanguage]): string {
  if (d.source === 'folder') return s.originFolder;
  return d.telescopeName ?? s.originTelescope;
}

function objectList(d: ImportAlertData, s: (typeof STRINGS)[AlertLanguage]): string {
  const names = d.objects.map(o => o.name);
  const shown = names.slice(0, MAX_LISTED_OBJECTS).join(', ');
  const rest = names.length - MAX_LISTED_OBJECTS;
  return rest > 0 ? `${shown} ${fill(s.more, { count: rest })}` : shown;
}

/** Under this much of the dark is "all night": the half-hour rounding of the hours would call it the same. */
const ALL_NIGHT_SLACK_HOURS = 0.25;
/** A Moon this thin does not matter to imaging, so it is not worth a timing. */
const THIN_MOON_PERCENT = 10;
const MAX_PLANNED_OBJECTS = 3;

/** What the alert may add to the three basic lines, and how to show a temperature. */
export interface AlertFormatOptions {
  details?: Partial<AlertDetails>;
  temperatureUnit?: 'celsius' | 'fahrenheit';
}

export function formatTemperature(celsius: number, unit: 'celsius' | 'fahrenheit'): string {
  return unit === 'fahrenheit' ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${Math.round(celsius)}°C`;
}

/** When the Moon matters: its phase and when it leaves or arrives, which is what a night's planning turns on. */
function moonLine(d: ClearNightAlertData, lang: AlertLanguage): string {
  const s = STRINGS[lang];
  if (d.moonIllumination <= THIN_MOON_PERCENT) return fill(s.clearMoonNone, { illum: d.moonIllumination });
  const crossings = [{ kind: 'sets', at: d.moonSet }, { kind: 'rises', at: d.moonRise }]
    .filter((c): c is { kind: string; at: string } => c.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = crossings[0];
  if (first) {
    return fill(first.kind === 'sets' ? s.clearMoonSets : s.clearMoonRises, { illum: d.moonIllumination, time: formatClock(first.at, d.timeZone) });
  }
  return d.moonDownHours > 0
    ? fill(s.clearMoon, { illum: d.moonIllumination, down: formatHours(d.moonDownHours, lang) })
    : fill(s.clearMoonUp, { illum: d.moonIllumination });
}

function dewLine(d: ClearNightAlertData, lang: AlertLanguage, unit: 'celsius' | 'fahrenheit'): string | null {
  const dew = d.dew;
  if (!dew || dew.lowTempC === null) return null;
  const s = STRINGS[lang];
  const temp = formatTemperature(dew.lowTempC, unit);
  if (dew.level === 'none' || !dew.from) return fill(s.clearDewNone, { temp });
  return fill(dew.level === 'likely' ? s.clearDewLikely : s.clearDewPossible, { time: formatClock(dew.from, d.timeZone), temp });
}

function planLine(d: ClearNightAlertData, lang: AlertLanguage): string | null {
  const plan = d.plan;
  if (!plan) return null;
  const s = STRINGS[lang];
  if (plan.objects.length === 0) return s.clearPlanNone;
  const shown = plan.objects.slice(0, MAX_PLANNED_OBJECTS).join(', ');
  const rest = plan.objects.length - MAX_PLANNED_OBJECTS;
  return fill(s.clearPlan, { objects: rest > 0 ? `${shown} ${fill(s.more, { count: rest })}` : shown });
}

/**
 * The lines a phone's lock screen shows, most important first so that anything cut off is the least important: what to expect, then (when
 * chosen) what is planned and the dew, then the Moon, then seeing and clouds.
 */
function clearNightBody(d: ClearNightAlertData, lang: AlertLanguage, options: AlertFormatOptions): string {
  const s = STRINGS[lang];
  const times = { start: formatClock(d.longestStart, d.timeZone), end: formatClock(d.longestEnd, d.timeZone) };
  const allNight = d.clearHours >= d.darkHours - ALL_NIGHT_SLACK_HOURS;
  const lines: (string | null)[] = [
    allNight
      ? fill(s.clearAllNight, times)
      : fill(s.clearPartial, { clear: formatHours(d.clearHours, lang), dark: formatHours(d.darkHours, lang), ...times }),
    options.details?.plan ? planLine(d, lang) : null,
    options.details?.dew ? dewLine(d, lang, options.temperatureUnit ?? 'celsius') : null,
    moonLine(d, lang),
  ];
  if (d.seeing !== null) {
    const key = `seeing${Math.min(5, Math.max(1, Math.round(d.seeing)))}` as AlertStringKey;
    lines.push(fill(s.clearConditions, { label: s[key], pct: d.maxCloudCover }));
  } else {
    lines.push(fill(s.clearClouds, { pct: d.maxCloudCover }));
  }
  return lines.filter((l): l is string => l !== null).join('\n');
}

export function formatAlert(event: AlertEvent, lang: AlertLanguage, options: AlertFormatOptions = {}): AlertMessage {
  const s = STRINGS[lang];
  switch (event.type) {
    case 'import.finished': {
      const d = event.data;
      const vars = { count: d.newFiles, origin: importOrigin(d, s), objects: objectList(d, s) };
      return {
        title: s.importFinishedTitle,
        body: fill(d.objects.length > 0 ? s.importFinishedBody : s.importFinishedNoObjects, vars),
        tags: ['inbox_tray'],
        url: null,
        lead: null,
      };
    }
    case 'import.failed':
      return {
        title: s.importFailedTitle,
        body: fill(s.importFailedBody, { origin: importOrigin(event.data, s), error: event.data.error ?? '?' }),
        tags: ['warning'],
        url: null,
        lead: null,
      };
    case 'night.clear': {
      const body = clearNightBody(event.data, lang, options);
      return {
        title: fill(s.clearTitle, { site: event.data.siteName }), body, tags: ['milky_way'], url: null, lead: body.split('\n')[0] ?? null,
        // With the plan line on, a tap opens the planner, so the line's "tap to plan" is true.
        deepLink: options.details?.plan ? 'nebulis://planner' : null,
      };
    }
    case 'night.dew': {
      const d = event.data;
      const lines = [fill(d.level === 'likely' ? s.dewLikely : s.dewPossible, { time: formatClock(d.from, d.timeZone) })];
      if (d.lowTempC !== null) lines.push(fill(s.dewLow, { temp: formatTemperature(d.lowTempC, options.temperatureUnit ?? 'celsius') }));
      // The first line is the point of the warning, so a phone shows it under the title.
      return { title: fill(s.dewTitle, { site: d.siteName }), body: lines.join('\n'), tags: ['droplet'], url: null, lead: lines[0] ?? null };
    }
    case 'update.available':
      return {
        title: fill(s.updateTitle, { version: event.data.latestVersion }),
        body: fill(s.updateBody, { current: event.data.currentVersion }),
        tags: ['arrow_up'],
        url: event.data.notesUrl,
        lead: null,
      };
    case 'test':
      return { title: s.testTitle, body: s.testBody, tags: ['bell'], url: null, lead: null };
  }
}
