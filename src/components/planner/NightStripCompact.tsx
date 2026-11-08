/**
 * The night picker in its slim form, for the collapsed planner banner.
 *
 * The full strip (NightStrip) is a row of its own under the banner. When the
 * banner is collapsed and the window is wide enough, the nights move up into
 * the banner instead, so the targets and the schedule start a row higher. The
 * chips shrink to what decides whether a night is worth planning: the weekday,
 * the date and the forecast bar. The selected night opens up in place into the
 * banner's verdict (rating, Moon, cloud), so the banner describes a night once,
 * as the first chip when tonight is chosen. The Moon's phase on the other
 * nights moves to the tooltip, and the calendar becomes a small icon button.
 */
import type { ReactNode } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { scoreHex } from '../../lib/forecastScore';
import { formatDate } from '../../lib/formatLocale';
import { translateMoonPhase } from '../../lib/moonPhaseLabel';
import { useTheme } from '../../hooks/useTheme';
import type { StripNight } from './NightStrip';

interface Props {
  nights: StripNight[];
  selectedKey: string;
  onSelect: (date: Date) => void;
  onStep: (days: number) => void;
  onOpenCalendar: () => void;
  /** The banner's verdict block, shown in place of the selected night's chip. */
  verdict: ReactNode;
  accent: string;
}

/** Nights shown at once: the selected night's card and the days after it. */
const VISIBLE_NIGHTS = 6;

const ICON_BTN =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';

export function NightStripCompact({
  nights, selectedKey, onSelect, onStep, onOpenCalendar, verdict, accent,
}: Props) {
  const { t } = useTranslation('planner');
  const { isNight } = useTheme();

  // The window stays anchored on the first nights, so a night picked within it
  // opens in place and nothing shifts. Only stepping past its end slides it, one
  // night at a time, to keep the selected night in view.
  const selectedIdx = Math.max(0, nights.findIndex(n => n.key === selectedKey));
  const start = Math.max(0, Math.min(selectedIdx - (VISIBLE_NIGHTS - 1), nights.length - VISIBLE_NIGHTS));
  const shown = nights.slice(start, start + VISIBLE_NIGHTS);

  return (
    <div className="flex min-w-0 items-center justify-center gap-1">
      <button type="button" onClick={() => onStep(-1)} aria-label={t('nightStrip.previousNight')} title={t('nightStrip.previousNight')} className={ICON_BTN}>
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div className="flex min-w-0 items-center gap-1">
        {shown.map(night => {
          const selected = night.key === selectedKey;
          if (selected) {
            return (
              <div
                key={night.key}
                aria-current="date"
                className="shrink-0 rounded-2xl bg-white/[0.07] px-2.5 py-1.5 ring-1 ring-inset"
                style={{ '--tw-ring-color': `${accent}80` } as React.CSSProperties}
              >
                {verdict}
              </div>
            );
          }
          const hex = night.score != null ? scoreHex(night.score, isNight) : null;
          const label = formatDate(night.date, { weekday: 'short' });
          return (
            <button
              key={night.key}
              type="button"
              onClick={() => onSelect(night.date)}
              title={[
                night.isToday ? t('nightStrip.tonight') : null,
                t('nightStrip.moonLit', { phase: translateMoonPhase(t, night.moonPhase), percent: Math.round(night.moonIllumination) }),
                night.score != null ? t('nightStrip.forecastScore', { score: night.score }) : t('nightStrip.pastForecastRange'),
                night.plannedCount > 0 ? t('nightStrip.blocksPlanned', { count: night.plannedCount }) : null,
              ].filter(Boolean).join(' · ')}
              // Tonight keeps an outline and its name even when another night is
              // selected, so it stays findable among the chips.
              className={`relative flex h-11 shrink-0 flex-col items-center justify-center rounded-xl transition ${
                night.isToday ? 'w-[52px] ring-1 ring-inset' : 'w-[46px]'
              } hover:bg-white/[0.06]`}
              style={night.isToday ? ({ '--tw-ring-color': `${accent}66` } as React.CSSProperties) : undefined}
            >
              <span
                className={`text-[0.5625rem] font-medium uppercase ${night.isToday ? 'tracking-tight' : 'tracking-wide text-white/45'}`}
                style={night.isToday ? { color: accent } : undefined}
              >
                {night.isToday ? t('nightStrip.tonight') : label}
              </span>
              <span className="font-display text-sm font-semibold leading-none tabular-nums text-white/90">
                {night.date.getDate()}
              </span>
              <span className="mt-1 h-[3px] w-6 overflow-hidden rounded-full bg-white/10">
                {hex && <span className="block h-full rounded-full" style={{ width: `${Math.max(10, night.score ?? 0)}%`, background: hex }} />}
              </span>
              {night.plannedCount > 0 && (
                <span className="absolute bottom-1 right-1.5 h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
              )}
            </button>
          );
        })}
      </div>

      <button type="button" onClick={() => onStep(1)} aria-label={t('nightStrip.nextNight')} title={t('nightStrip.nextNight')} className={ICON_BTN}>
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" onClick={onOpenCalendar} aria-label={t('nightStrip.pickADate')} title={t('nightStrip.pickADate')} className={ICON_BTN}>
        <Calendar className="h-4 w-4" />
      </button>
    </div>
  );
}
