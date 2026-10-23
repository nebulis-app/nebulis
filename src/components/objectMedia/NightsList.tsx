import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ImageOff } from 'lucide-react';
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

/**
 * The Nights tab: one row per night the object was shot, each opening that night's observation page. The same
 * pictures the other tabs show, listed by when they were taken.
 */
export function NightsList({ objectId, nights, items }: {
  /** The object's own id, used for a night none of the loaded items can place. */
  objectId: string;
  nights: MediaGroup[];
  items: MediaItem[];
}) {
  const { t } = useTranslation('library');
  const { isDark, isNight } = useTheme();
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const faint = isDark ? 'text-slate-600' : 'text-slate-300';

  // A night can sit under one of the object's variants (a mosaic, a filter), so the link goes to whichever object
  // the night's own files live under, and the telescope's colour comes from the same file.
  const byNight = new Map<string, MediaItem[]>();
  for (const i of items) {
    if (i.kind === 'project') continue;
    const list = byNight.get(i.groupKey);
    if (list) list.push(i); else byNight.set(i.groupKey, [i]);
  }
  const header = `px-4 pb-2 pt-3 text-[0.6875rem] font-medium uppercase tracking-wide ${muted}`;

  return (
    <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
      <div className={`hidden gap-x-4 border-b md:grid ${COLUMNS} ${header} ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <span />
        <span>{t('objectMedia.nights.col.night')}</span>
        <span>{t('objectMedia.nights.col.pictures')}</span>
        <span>{t('objectMedia.nights.col.frames')}</span>
        <span>{t('objectMedia.nights.col.integration')}</span>
        <span>{t('objectMedia.nights.col.quality')}</span>
        <span className="w-24" />
      </div>
      <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-200'}`}>
        {nights.map(n => {
          const date = n.date;
          if (!date) return null;
          const nightItems = byNight.get(n.key) ?? [];
          const home = nightItems.find(i => i.kind !== 'processed')?.objectId ?? objectId;
          const telescope = nightItems.find(i => i.telescope)?.telescope ?? null;
          const cover = coverFor(nightItems);
          const pictures = n.count - n.subCount;
          const frames = n.subCount > 0
            ? n.exposure
              ? t('objectMedia.group.framesExposure', { count: n.frames, exposure: n.exposure })
              : t('objectMedia.group.frames', { count: n.frames })
            : null;
          const integration = n.integrationSec ? formatDuration(n.integrationSec) : null;
          const summary = [
            pictures > 0 ? t('objectMedia.nights.pictures', { count: pictures }) : null,
            frames,
            integration ? t('objectMedia.group.integration', { time: integration }) : null,
          ].filter(Boolean).join(' · ');
          const cell = (value: string | null) => (
            <span className={`hidden text-sm tabular-nums md:block ${value ? (isDark ? 'text-slate-200' : 'text-slate-700') : faint}`}>{value ?? '–'}</span>
          );
          return (
            <li key={n.key}>
              <Link
                to={`/observations/${encodeURIComponent(home)}/${encodeURIComponent(date)}`}
                className={`grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${COLUMNS} ${
                  isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
                }`}
              >
                <span className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  {cover?.thumbUrl
                    ? <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
                    : <ImageOff className={`h-4 w-4 ${faint}`} aria-hidden="true" />}
                </span>
                <span className="min-w-0">
                  <span className={`block truncate text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {formatDate(new Date(`${date}T12:00:00`), { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })}
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
                  {n.subCount > 0 ? <NightQuality objectId={home} date={date} /> : <span className={`text-sm ${faint}`}>–</span>}
                </span>
                <span className={`inline-flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-medium ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
                  {t('objectMedia.nights.open')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
