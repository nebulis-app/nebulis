import { CheckCircle2, Circle, Maximize2 } from 'lucide-react';
import { formatNumber } from '../../lib/formatLocale';
import { FitsThumbnail } from '../FitsThumbnail';
import { BASE, FLAG_ICONS, gradeColor, n0, n1, reasonText, type FrameRowData, type TFunc } from './frameFormat';

interface RowProps {
  row: FrameRowData;
  selected: boolean;
  onToggle: () => void;
  /** Opens the frame. Without it, the whole row toggles selection. */
  onOpen?: () => void;
  /** Adds a button that opens the frame in the viewer, for a list where clicking the row selects it. */
  onView?: () => void;
  /** Shown instead of the numbers while a frame has none. */
  placeholder: string;
  /** Set when the file could not be read. */
  failure?: string;
  /** Translation function bound to `observations`. */
  t: TFunc;
  isDark: boolean;
}

export function FrameRow({ row, selected, onToggle, onOpen, onView, placeholder, failure, t, isDark }: RowProps) {
  const text = isDark ? 'text-slate-200' : 'text-slate-700';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const chip = isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const m = row.metrics;
  const v = row.verdict;
  const firstReason = v?.reasons[0];
  const open = onOpen ?? onToggle;

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 transition ${
      selected ? 'bg-accent-500/10' : isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={t(`${BASE}.selectFrame`, { name: row.name })}
        className="mt-5 flex-shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        {selected
          ? <CheckCircle2 className="w-4 h-4 text-accent-500" />
          : <Circle className={`w-4 h-4 ${muted}`} />}
      </button>
      <button
        type="button"
        onClick={open}
        className="flex flex-1 min-w-0 items-start gap-3 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <span className={`w-28 h-[72px] flex-shrink-0 rounded-md overflow-hidden border ${isDark ? 'border-slate-700 bg-black' : 'border-slate-200 bg-slate-100'}`}>
          <FitsThumbnail url={row.downloadUrl} thumbUrl={row.thumbUrl ?? undefined} stretch={1.0} isDark={isDark} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-medium truncate max-w-[22rem] ${text}`}>{row.name}</span>
            {v?.flags.map(f => {
              const Icon = FLAG_ICONS[f];
              return (
                <span key={f} className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${chip}`}>
                  <Icon className="w-3 h-3" />
                  {t(`${BASE}.flags.${f}`)}
                </span>
              );
            })}
          </span>
          {m ? (
            <>
              <span className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                <Stat label={t(`${BASE}.stats.stars`)} value={n0(m.starCount)} muted={muted} text={text} />
                <Stat label={t(`${BASE}.stats.width`)} value={m.fwhm !== null ? t(`${BASE}.stats.pixels`, { value: n1(m.fwhm) }) : '–'} muted={muted} text={text} />
                <Stat label={t(`${BASE}.stats.round`)} value={m.elongation !== null ? formatNumber(m.elongation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–'} muted={muted} text={text} />
                <Stat label={t(`${BASE}.stats.noise`)} value={n1(m.noise)} muted={muted} text={text} />
                {m.peakSNR !== null && <Stat label={t(`${BASE}.stats.signal`)} value={t(`${BASE}.stats.times`, { value: n0(m.peakSNR) })} muted={muted} text={text} />}
              </span>
              {firstReason && <span className={`mt-1 block text-xs ${muted}`}>{reasonText(t, firstReason)}</span>}
            </>
          ) : failure ? (
            <span className={`mt-1 block text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
              {t(`${BASE}.unreadable`, { reason: failure })}
            </span>
          ) : (
            <span className={`mt-1 block text-xs ${muted}`}>{placeholder}</span>
          )}
        </span>
        {v && (
          <span className="w-14 flex-shrink-0 text-right pt-1">
            <span className={`block text-xl font-semibold tabular-nums ${gradeColor(v.grade, isDark)}`}>{v.score}</span>
            <span className={`block text-xs ${muted}`}>{t(`${BASE}.grades.${v.grade}`)}</span>
          </span>
        )}
      </button>
      {onView && (
        <button
          type="button"
          onClick={onView}
          title={t(`${BASE}.openFrame`)}
          aria-label={t(`${BASE}.openFrame`)}
          className={`mt-5 flex-shrink-0 rounded-md p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            isDark ? 'text-slate-400 hover:bg-slate-700 hover:text-slate-100' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'
          }`}
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, muted, text }: { label: string; value: string; muted: string; text: string }) {
  return (
    <span className="flex flex-col">
      <span className={`text-[0.625rem] uppercase tracking-wide ${muted}`}>{label}</span>
      <span className={`text-sm tabular-nums ${text}`}>{value}</span>
    </span>
  );
}
