import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronDown, ImageOff } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { formatDuration } from '../../lib/captureMetrics';
import { formatDate } from '../../lib/formatLocale';
import type { MediaGroup, MediaItem } from '../../lib/api/library';
import { NightQuality } from './SubframeNights';

/** Thumbnail, night, pictures, frames, integration, quality and the way in. Below `md` the figures fold into one line. */
const COLUMNS = 'md:grid-cols-[3.5rem_minmax(13rem,2.2fr)_minmax(4rem,1fr)_minmax(7rem,1.2fr)_minmax(5rem,1fr)_minmax(8rem,1.3fr)_auto]';

/** The picture that stands for a night: a finished one, else the telescope's own, never a raw frame. */
function coverFor(items: MediaItem[]): MediaItem | undefined {
  const pictures = items.filter(i => i.isImage && !i.isFits && i.thumbUrl);
  return pictures.find(i => i.kind === 'processed') ?? pictures.find(i => i.kind === 'telescope') ?? pictures[0];
}

/** Observation groups carry `date|exposure`; pictures with no exposure (processed images, videos) sit under `date|`. */
const hasExposure = (g: MediaGroup): boolean => !g.key.endsWith('|');

/** The exposure a group is for, read from its key: `group.exposure` is only set when the group holds sub-frames, and a
 *  setting made of stacked pictures alone has none. */
const exposureOf = (g: MediaGroup): string => g.key.slice(g.key.indexOf('|') + 1);

interface Night {
  date: string;
  /** Every observation group of the night, for the totals. */
  groups: MediaGroup[];
  /** One per exposure setting, shown when the night has more than one. */
  settings: MediaGroup[];
}

/** Folds observation groups back into nights. The server orders them already; a night keeps its first position. */
function nightsOf(groups: MediaGroup[]): Night[] {
  const byDate = new Map<string, Night>();
  for (const g of groups) {
    if (!g.date) continue;
    let night = byDate.get(g.date);
    if (!night) { night = { date: g.date, groups: [], settings: [] }; byDate.set(g.date, night); }
    night.groups.push(g);
    if (hasExposure(g)) night.settings.push(g);
  }
  return [...byDate.values()];
}

const sum = (groups: MediaGroup[], pick: (g: MediaGroup) => number): number => groups.reduce((n, g) => n + pick(g), 0);

/**
 * The Nights tab: one row per night the object was shot, each opening that night's observation page. A night shot at
 * more than one exposure setting can be opened into one row per setting, so 30 s and 15 s frames are not run together.
 */
export function NightsList({ objectId, observations, items, solar = false }: {
  /** The object's own id, used for a night none of the loaded items can place. */
  objectId: string;
  /** The media groups with `group=observation`: a night at one exposure each. */
  observations: MediaGroup[];
  items: MediaItem[];
  /** The Sun: columns and links say day, not night. */
  solar?: boolean;
}) {
  const { t } = useTranslation('library');
  const { isDark, isNight } = useTheme();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const faint = isDark ? 'text-slate-600' : 'text-slate-300';
  const strong = isDark ? 'text-slate-200' : 'text-slate-700';

  // A night can sit under one of the object's variants (a mosaic, a filter), so the link goes to whichever object
  // the night's own files live under, and the telescope's colour comes from the same file.
  const dateOfKey = new Map(observations.flatMap(g => (g.date ? [[g.key, g.date] as const] : [])));
  const byNight = new Map<string, MediaItem[]>();
  for (const i of items) {
    if (i.kind === 'project') continue;
    const date = dateOfKey.get(i.groupKey);
    if (!date) continue;
    const list = byNight.get(date);
    if (list) list.push(i); else byNight.set(date, [i]);
  }
  const nights = nightsOf(observations);
  const header = `px-4 pb-2 pt-3 text-[0.6875rem] font-medium uppercase tracking-wide ${muted}`;
  const toggle = (date: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(date)) next.add(date);
    return next;
  });

  const cell = (value: string | null) => (
    <span className={`hidden text-sm tabular-nums md:block ${value ? strong : faint}`}>{value ?? '–'}</span>
  );
  const framesText = (frames: number, exposure: string | null): string =>
    exposure ? t('objectMedia.group.framesExposure', { count: frames, exposure }) : t('objectMedia.group.frames', { count: frames });
  const linkClass = `grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${COLUMNS} ${
    isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
  }`;
  const openLabel = (
    <span className={`inline-flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-medium ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
      {t(solar ? 'objectMedia.nights.openDay' : 'objectMedia.nights.open')}
      <ArrowRight className="h-3.5 w-3.5" />
    </span>
  );

  return (
    <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
      <div className={`hidden gap-x-4 border-b md:grid ${COLUMNS} ${header} ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <span />
        <span>{t(solar ? 'objectMedia.nights.col.day' : 'objectMedia.nights.col.night')}</span>
        <span>{t('objectMedia.nights.col.pictures')}</span>
        <span>{t('objectMedia.nights.col.frames')}</span>
        <span>{t('objectMedia.nights.col.integration')}</span>
        <span>{t('objectMedia.nights.col.quality')}</span>
        <span className="w-24" />
      </div>
      <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-200'}`}>
        {nights.map(n => {
          const nightItems = byNight.get(n.date) ?? [];
          const home = nightItems.find(i => i.kind !== 'processed')?.objectId ?? objectId;
          const telescope = nightItems.find(i => i.telescope)?.telescope ?? null;
          const cover = coverFor(nightItems);
          const subCount = sum(n.groups, g => g.subCount);
          const pictures = sum(n.groups, g => g.count) - subCount;
          const exposures = new Set(n.settings.map(exposureOf));
          const frameTotal = sum(n.groups, g => g.frames);
          const frames = subCount > 0 ? framesText(frameTotal, exposures.size === 1 ? [...exposures][0] : null) : null;
          const integrationSec = sum(n.groups, g => g.integrationSec ?? 0);
          const integration = integrationSec > 0 ? formatDuration(integrationSec) : null;
          const summary = [
            pictures > 0 ? t('objectMedia.nights.pictures', { count: pictures }) : null,
            frames,
            integration ? t('objectMedia.group.integration', { time: integration }) : null,
          ].filter(Boolean).join(' · ');
          const expandable = n.settings.length > 1;
          const expanded = expandable && open.has(n.date);
          const nightHref = `/observations/${encodeURIComponent(home)}/${encodeURIComponent(n.date)}`;
          return (
            <li key={n.date}>
              <Link to={nightHref} className={linkClass}>
                <span className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  {cover?.thumbUrl
                    ? <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
                    : <ImageOff className={`h-4 w-4 ${faint}`} aria-hidden="true" />}
                </span>
                <span className="min-w-0">
                  <span className={`block truncate text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {formatDate(new Date(`${n.date}T12:00:00`), { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })}
                  </span>
                  <span className={`flex items-center gap-1.5 truncate text-xs ${muted}`}>
                    {telescope && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: nightSafeColor(telescope.color, isNight) }} />
                    )}
                    <span className="truncate">
                      {telescope?.name}
                      <span className="md:hidden">{telescope && summary ? ' · ' : ''}{summary}</span>
                    </span>
                  </span>
                </span>
                {cell(pictures > 0 ? String(pictures) : null)}
                {cell(frames)}
                {cell(integration)}
                <span className="hidden md:block">
                  {subCount > 0 ? <NightQuality objectId={home} date={n.date} /> : <span className={`text-sm ${faint}`}>–</span>}
                </span>
                {openLabel}
              </Link>

              {expandable && (
                <button
                  type="button"
                  onClick={() => toggle(n.date)}
                  aria-expanded={expanded}
                  className={`flex w-full items-center gap-1.5 px-4 pb-2 pl-[5.25rem] text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
                    isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'
                  }`}
                >
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                  {expanded ? t('objectMedia.nights.hideSettings') : t('objectMedia.nights.showSettings', { count: n.settings.length })}
                </button>
              )}

              {expanded && (
                <ul className={`border-t ${isDark ? 'border-slate-800 bg-slate-900/40' : 'border-slate-100 bg-slate-50/60'}`}>
                  {n.settings.map(g => {
                    const settingIntegration = g.integrationSec ? formatDuration(g.integrationSec) : null;
                    const settingPictures = g.count - g.subCount;
                    return (
                      <li key={g.key}>
                        <Link to={nightHref} className={linkClass}>
                          <span />
                          <span className={`min-w-0 truncate pl-3 text-sm font-medium ${strong}`}>
                            {exposureOf(g)}
                            <span className={`md:hidden ${muted}`}>
                              {' · '}{[
                                settingPictures > 0 ? t('objectMedia.nights.pictures', { count: settingPictures }) : null,
                                g.subCount > 0 ? framesText(g.frames, exposureOf(g)) : null,
                                settingIntegration,
                              ].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          {cell(settingPictures > 0 ? String(settingPictures) : null)}
                          {cell(g.subCount > 0 ? framesText(g.frames, exposureOf(g)) : null)}
                          {cell(settingIntegration)}
                          {cell(null)}
                          <span className="w-24" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
