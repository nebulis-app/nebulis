/**
 * The month label in the observations toolbar, as a button that opens a small
 * month/year picker.
 *
 * The chevrons step one month at a time, which is slow for going back a year or
 * two. Clicking the label opens a grid of the twelve months with a year stepper
 * above it, so any month in the record is two clicks away.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

interface Props {
  /** The year currently on the calendar. */
  year: number;
  /** The month currently on the calendar, 0-11. */
  month: number;
  /** Pre-formatted label, e.g. "September 2026". */
  label: string;
  isDark: boolean;
  onPick: (year: number, month: number) => void;
}

export function MonthYearMenu({ year, month, label, isDark, onPick }: Props) {
  const [open, setOpen] = useState(false);
  /** The year the grid is paging through, separate from the committed one so
   *  you can look at another year without leaving the month you're on. */
  const [viewYear, setViewYear] = useState(year);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    // Always (re)open on the year you're currently looking at.
    setViewYear(year);
    setOpen(o => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`font-display min-w-[10rem] rounded-lg px-2 py-1 text-sm font-semibold tabular-nums transition ${
          isDark ? 'text-white hover:bg-slate-800' : 'text-slate-900 hover:bg-slate-100'
        }`}
      >
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Jump to a month"
          className={`absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-xl border p-3 shadow-xl ${
            isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
          }`}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear(y => y - 1)}
              aria-label={`Show ${viewYear - 1}`}
              className={`rounded-lg p-1 transition ${
                isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className={`font-display text-sm font-semibold tabular-nums ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}>
              {viewYear}
            </span>
            <button
              type="button"
              onClick={() => setViewYear(y => y + 1)}
              aria-label={`Show ${viewYear + 1}`}
              className={`rounded-lg p-1 transition ${
                isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {MONTHS_SHORT.map((m, i) => {
              const selected = viewYear === year && i === month;
              // Filled in light mode, tinted in dark: `text-accent` on a light
              // `bg-accent/15` tint is under AA, the same reason the view switch
              // pills are drawn this way.
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { onPick(viewYear, i); setOpen(false); }}
                  aria-pressed={selected}
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                    selected
                      ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-500 text-white'
                      : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
