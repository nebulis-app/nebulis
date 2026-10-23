/**
 * Which night are you planning? The next couple of weeks as pickable nights.
 *
 * This is navigation, so it sits on the page as its own row rather than inside
 * the night panel. A stepper makes you walk to a night to find out whether it
 * is worth planning; the strip puts the answer on the chip: forecast rating as
 * a bar, the Moon's real phase, and a dot when you already have blocks
 * scheduled. Nights past the forecast horizon still show Moon and schedule,
 * which is most of what decides a target list anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { scoreHex, scoreLabel } from '../../lib/forecastScore';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useTheme } from '../../hooks/useTheme';
import { MoonDisk } from '../ui/MoonDisk';
import { translateMoonPhase } from '../../lib/moonPhaseLabel';
import { formatDate } from '../../lib/formatLocale';

export interface StripNight {
  /** Noon-anchored Date for the evening this night begins on. */
  date: Date;
  /** YYYY-MM-DD, the identity used for selection. */
  key: string;
  /** Forecast rating 0-100, or null past the forecast horizon. */
  score: number | null;
  moonIllumination: number;
  moonPhase: string;
  plannedCount: number;
  isToday: boolean;
}

interface Props {
  nights: StripNight[];
  selectedKey: string;
  onSelect: (date: Date) => void;
  onStep: (days: number) => void;
  onOpenCalendar: () => void;
}

export function NightStrip({ nights, selectedKey, onSelect, onStep, onOpenCalendar }: Props) {
  const { t } = useTranslation('planner');
  const { isDark, isNight } = useTheme();
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  // Keep the chosen night in view when the date changes from somewhere else
  // (the arrows, the calendar, or a "Plan Tonight" hand-off from a catalog).
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selectedKey]);

  const stepClass = isDark
    ? 'bg-slate-900 text-slate-400 ring-slate-800 hover:bg-slate-800 hover:text-slate-200'
    : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-100 hover:text-slate-700';

  return (
    <div className="flex items-center gap-2">
      <StepButton label={t('nightStrip.previousNight')} onClick={() => onStep(-1)} className={stepClass}>
        <ChevronLeft className="h-4 w-4" />
      </StepButton>

      {/* A week wide at most, not the whole page. The arrows walk the selection
          into the rest of the fortnight (the chosen night scrolls itself into
          view), so the strip never needs to show every night at once. Sizing to
          content also stops the arrows drifting to opposite screen edges.
          Widths are whole chips: 3, then 5, then 7, so a chip is never sliced
          in half by the container. */}
      <div className="flex w-[14.5rem] max-w-full gap-2 overflow-x-auto pb-0.5 lg:w-[24.5rem] xl:w-[34.5rem] no-scrollbar">
        {nights.map(night => {
          const selected = night.key === selectedKey;
          const hex = night.score != null ? scoreHex(night.score, isNight) : null;
          return (
            <button
              key={night.key}
              ref={selected ? selectedRef : undefined}
              onClick={() => onSelect(night.date)}
              aria-current={selected ? 'date' : undefined}
              className={`relative w-[72px] shrink-0 rounded-xl px-1.5 pb-1.5 pt-2 text-center ring-1 ring-inset transition ${
                selected
                  ? isDark
                    ? 'bg-slate-800 ring-accent-500/60'
                    : 'bg-white shadow-sm ring-accent-500/60'
                  : isDark
                    ? 'bg-slate-900/70 ring-slate-800 hover:bg-slate-800/80'
                    : 'bg-white ring-slate-200 hover:bg-slate-50'
              }`}
              title={[
                t('nightStrip.moonLit', { phase: translateMoonPhase(t, night.moonPhase), percent: Math.round(night.moonIllumination) }),
                night.score != null ? t('nightStrip.forecastScore', { score: night.score }) : t('nightStrip.pastForecastRange'),
                night.plannedCount > 0 ? t('nightStrip.blocksPlanned', { count: night.plannedCount }) : null,
              ].filter(Boolean).join(' · ')}
            >
              <div className={`text-[0.5938rem] font-medium uppercase tracking-[0.06em] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                {night.isToday ? t('nightStrip.tonight') : formatDate(night.date, { weekday: 'short' })}
              </div>
              <div className="mt-0.5 flex items-center justify-center gap-1">
                <span className={`font-display text-base font-semibold leading-none tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  {night.date.getDate()}
                </span>
                {/* On a light page the Moon's cream limb has nothing to read
                    against, so a crescent looks like a plain dark dot. Sitting
                    it on a scrap of night sky restores the phase. */}
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-950">
                  <MoonDisk illumination={night.moonIllumination} phase={night.moonPhase} size={15} />
                </span>
              </div>
              <div className={`mt-1.5 h-1 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
                {hex && (
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.max(6, night.score ?? 0)}%`, background: hex }}
                  />
                )}
              </div>
              {/* A dot, not a count: the exact number matters less than knowing
                  the night already has a plan on it, and the title carries it. */}
              {night.plannedCount > 0 && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent-500" />
              )}
            </button>
          );
        })}
      </div>

      <StepButton label={t('nightStrip.nextNight')} onClick={() => onStep(1)} className={stepClass}>
        <ChevronRight className="h-4 w-4" />
      </StepButton>
      <StepButton label={t('nightStrip.pickADate')} onClick={onOpenCalendar} className={`${stepClass} w-[58px]`}>
        <Calendar className="h-4 w-4" />
      </StepButton>
      <StripLegend isDark={isDark} isNight={isNight} />
    </div>
  );
}

function StepButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-[58px] w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * What the chips are saying, once, instead of in each chip's tooltip: the bar is
 * the forecast rating, the dot is a night that already has a plan, the disk is
 * the Moon. Nothing on the strip explains itself otherwise, and the blue bar
 * (a mid rating) read to some as a different kind of night.
 */
function StripLegend({ isDark, isNight }: { isDark: boolean; isNight: boolean }) {
  const { t } = useTranslation('planner');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';
  // One score per rating band, best first, so the key shows the whole scale.
  const samples = [90, 75, 60, 45, 30];

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('nightStrip.legendLabel')}
        title={t('nightStrip.legendTitle')}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
          isDark ? 'text-slate-500 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
        }`}
      >
        <Info className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('nightStrip.legendLabel')}
          className={`absolute left-0 top-full z-30 mt-1.5 w-72 space-y-3 rounded-xl border p-3 shadow-xl ${
            isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
          }`}
        >
          <div>
            <div className={`text-xs font-medium ${strong}`}>{t('nightStrip.legendRating')}</div>
            <div className={`mb-1.5 text-[0.6875rem] ${muted}`}>{t('nightStrip.legendRatingHint')}</div>
            <ul className="space-y-1">
              {samples.map(score => (
                <li key={score} className="flex items-center gap-2">
                  <span className={`h-1 w-10 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
                    <span className="block h-full rounded-full" style={{ width: `${score}%`, background: scoreHex(score, isNight) }} />
                  </span>
                  <span className={`text-[0.6875rem] ${muted}`}>{scoreLabel(score, t)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
            <div>
              <div className={`text-xs font-medium ${strong}`}>{t('nightStrip.legendPlanned')}</div>
              <div className={`text-[0.6875rem] ${muted}`}>{t('nightStrip.legendPlannedHint')}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-950">
              <MoonDisk illumination={50} phase="First Quarter" size={13} />
            </span>
            <div>
              <div className={`text-xs font-medium ${strong}`}>{t('nightStrip.legendMoon')}</div>
              <div className={`text-[0.6875rem] ${muted}`}>{t('nightStrip.legendMoonHint')}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
