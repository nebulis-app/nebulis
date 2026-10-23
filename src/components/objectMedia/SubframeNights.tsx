import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Hourglass } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { formatDuration } from '../../lib/captureMetrics';
import { formatDate } from '../../lib/formatLocale';
import type { MediaGroup } from '../../lib/api/library';
import { getFrameAnalysis, type FrameAnalysisReport } from '../../lib/api/frameAnalysis';
import { summaryOf } from '../frameAnalysis/frameListLogic';

/**
 * The Subframes tab's front page: one row per night with how much was shot, and a button that
 * opens that night's frame list. Listing every night's frames at once would measure and load
 * them all, so the frames wait one click away.
 */
export function SubframeNights({ objectId, nights, onOpen }: {
  objectId: string;
  nights: MediaGroup[];
  onOpen: (date: string) => void;
}) {
  const { t } = useTranslation('library');
  const { isDark, isNight } = useTheme();
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';

  return (
    <ul className={`divide-y overflow-hidden rounded-xl border ${isDark ? 'divide-slate-800 border-slate-800' : 'divide-slate-200 border-slate-200'}`}>
      {nights.map(n => {
        const date = n.date;
        const meta = [
          n.exposure
            ? t('objectMedia.group.framesExposure', { count: n.frames, exposure: n.exposure })
            : t('objectMedia.group.frames', { count: n.frames }),
          n.integrationSec ? t('objectMedia.group.integration', { time: formatDuration(n.integrationSec) }) : null,
        ].filter(Boolean).join(' · ');
        const title = date
          ? formatDate(new Date(`${date}T12:00:00`), { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
          : t('objectMedia.group.noNight');
        return (
          <li key={n.key}>
            <button
              type="button"
              disabled={!date}
              onClick={() => { if (date) onOpen(date); }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
                isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
              }`}
            >
              {n.telescope && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: nightSafeColor(n.telescope.color, isNight) }} />
              )}
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</span>
                <span className={`block truncate text-xs ${muted}`}>
                  {[n.telescope?.name, meta].filter(Boolean).join(' · ')}
                </span>
              </span>
              {date && <NightQuality objectId={objectId} date={date} />}
              <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
                {t('objectMedia.subNights.open')}
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** True once the element has scrolled near the viewport, so a long list reads each night's results only as it is reached. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/**
 * What frame analysis already found for one night, read from the stored measurements: it never starts
 * measuring. Shares its cache entry with the night's frame list, so opening the night is instant.
 */
export function NightQuality({ objectId, date }: { objectId: string; date: string }) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const { data } = useQuery<FrameAnalysisReport>({
    queryKey: ['frame-analysis', objectId, date, true],
    queryFn: ({ signal }) => getFrameAnalysis(objectId, date, { includeVariants: true, signal }),
    enabled: seen,
    staleTime: 30_000,
  });

  let text: string | null = null;
  let title: string | undefined;
  let tone: 'ok' | 'warn' | 'quiet' = 'quiet';
  if (data && data.total > 0) {
    const BASE = 'observationDetail.frameList';
    if (data.measured === 0) { text = t(`${BASE}.notMeasured`); title = t(`${BASE}.notMeasuredTitle`); }
    else if (data.measured < data.total) {
      text = t(`${BASE}.measuredOf`, { measured: data.measured, total: data.total });
      title = t(`${BASE}.measuredOfTitle`);
    } else {
      const summary = summaryOf(data.frames);
      if (summary.flagged === 0) {
        text = t(`${BASE}.allClearShort`);
        title = t(`${BASE}.allClearTitle`, { count: data.total });
        tone = 'ok';
      } else {
        text = summary.bad > 0
          ? t(`${BASE}.flaggedAndBad`, { flagged: summary.flagged, bad: summary.bad })
          : t(`${BASE}.flagged`, { flagged: summary.flagged });
        title = t(`${BASE}.flaggedTitle`);
        tone = 'warn';
      }
    }
  }
  const color = tone === 'ok'
    ? isDark ? 'text-emerald-400' : 'text-emerald-600'
    : tone === 'warn'
      ? isDark ? 'text-amber-300' : 'text-amber-700'
      : isDark ? 'text-slate-500' : 'text-slate-400';
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : Hourglass;

  return (
    <span ref={ref} title={title} className={`hidden shrink-0 items-center gap-1 text-xs sm:inline-flex ${color}`}>
      {text && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {text}
    </span>
  );
}
