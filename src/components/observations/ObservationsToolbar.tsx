/**
 * Control bar for the observations page.
 *
 * The top row of the calendar / list / map card: the view switch on the left,
 * the month stepper centered (calendar view only), and the telescope filter
 * plus Share on the right. The page wraps this and the view below it in one
 * bordered card, so this renders as a header strip with just a bottom divider,
 * not a card of its own. It used to be a loose row of pills floating between
 * the hero and the grid, crammed against the hero's bottom edge.
 *
 * The month navigation used to live in the grid's own header; it moved here so
 * there is a single control row for whichever view is open.
 */
import {
  Calendar, ChevronDown, ChevronLeft, ChevronRight,
  List, Map as MapIcon, Share2, Telescope,
} from 'lucide-react';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { MonthYearMenu } from './MonthYearMenu';

export type ObservationsView = 'calendar' | 'list' | 'map';

export const ALL_TELESCOPES_FILTER = '__all__';

interface Props {
  view: ObservationsView;
  onViewChange: (v: ObservationsView) => void;
  /** Empty when fewer than two telescopes are configured, which hides the filter. */
  telescopes: TelescopeProfile[];
  telescopeFilter: string;
  onTelescopeFilterChange: (id: string) => void;
  onShare: (() => void) | null;
  shareTitle: string;
  isDark: boolean;
  /** Month navigation, shown in calendar view only. The list and map are not
   *  month-scoped, so the stepper is hidden there. */
  monthLabel: string;
  /** The year and month (0-11) currently on the calendar, for the picker. */
  year: number;
  month: number;
  onPickMonthYear: (year: number, month: number) => void;
  /** True when the grid is already on the month `today` falls in. */
  isCurrentMonth: boolean;
  onNavigateMonth: (direction: -1 | 1) => void;
  onGoToToday: () => void;
}

const VIEWS: { id: ObservationsView; label: string; Icon: typeof Calendar }[] = [
  { id: 'calendar', label: 'Calendar', Icon: Calendar },
  { id: 'list', label: 'List', Icon: List },
  { id: 'map', label: 'Map', Icon: MapIcon },
];

export function ObservationsToolbar({
  view, onViewChange,
  telescopes, telescopeFilter, onTelescopeFilterChange,
  onShare, shareTitle, isDark,
  monthLabel, year, month, onPickMonthYear,
  isCurrentMonth, onNavigateMonth, onGoToToday,
}: Props) {
  const controlBase = isDark
    ? 'bg-slate-900/70 ring-slate-700/60 text-slate-200'
    : 'bg-white ring-slate-200 text-slate-800';

  const stepBtn = isDark
    ? 'text-slate-400 hover:bg-slate-800'
    : 'text-slate-500 hover:bg-slate-100';

  const todayBtn = isDark
    ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800';

  return (
    <div
      className={`border-b px-3 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}
    >
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        {/* View switch */}
        <div
          role="group"
          aria-label="View"
          className={`inline-flex items-center gap-0.5 self-start rounded-full p-0.5 ring-1 ring-inset sm:justify-self-start ${
            isDark ? 'bg-slate-900/70 ring-slate-700/60' : 'bg-white ring-slate-200'
          }`}
        >
          {VIEWS.map(({ id, label, Icon }) => {
            const active = view === id;
            // The active pill is filled in light mode and tinted in dark, rather
            // than tinted in both. A tint reads well on a dark surface, but
            // `text-accent-700` on `bg-accent-500/15` over a light page measures
            // 4.18:1, under AA. Filled uses light mode's darkened accent-500
            // against white and clears it comfortably. Both values are re-mapped
            // by the .night and .space blocks, so the pill follows the theme.
            return (
              <button
                key={id}
                onClick={() => onViewChange(id)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40
                  ${active
                    ? isDark
                      ? 'bg-accent-500/15 text-accent-400'
                      : 'bg-accent-500 text-white'
                    : isDark
                      ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                  }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Month stepper — centered, calendar view only. The list and map show
            the whole record, so there is no month to step through. */}
        {view === 'calendar' ? (
          <div className="flex items-center justify-center gap-1 sm:justify-self-center">
            <button
              onClick={() => onNavigateMonth(-1)}
              aria-label="Previous month"
              className={`rounded-lg p-1.5 transition ${stepBtn}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <MonthYearMenu
              year={year}
              month={month}
              label={monthLabel}
              isDark={isDark}
              onPick={onPickMonthYear}
            />
            <button
              onClick={() => onNavigateMonth(1)}
              aria-label="Next month"
              className={`rounded-lg p-1.5 transition ${stepBtn}`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {!isCurrentMonth && (
              <button
                onClick={onGoToToday}
                className={`ml-1 rounded-full px-3 py-1.5 text-xs font-medium transition ${todayBtn}`}
              >
                Today
              </button>
            )}
          </div>
        ) : (
          <div className="hidden sm:block" />
        )}

        {/* Telescope filter + Share */}
        <div className="flex flex-wrap items-center gap-2 sm:justify-self-end">
          {telescopes.length >= 2 && (
            /**
             * `appearance-none` is load-bearing. A native select honours
             * `padding-left` in Chromium but clamps it in Safari, so the leading
             * icon ended up sitting on top of the first word of the label there
             * however much padding was set. Stripping the native appearance makes
             * the box ours in every browser, which then means drawing the chevron
             * ourselves since that goes with it.
             */
            <div className="relative inline-flex items-center">
              <Telescope
                className={`pointer-events-none absolute left-3 h-3.5 w-3.5 ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}
              />
              <select
                value={telescopeFilter}
                onChange={e => onTelescopeFilterChange(e.target.value)}
                aria-label="Filter by telescope"
                className={`cursor-pointer appearance-none rounded-full py-1.5 pl-9 pr-8 text-xs ring-1 ring-inset transition
                  focus:outline-none focus:ring-2 focus:ring-accent-500/40 ${controlBase}`}
              >
                <option value={ALL_TELESCOPES_FILTER}>All telescopes</option>
                {telescopes.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <ChevronDown
                className={`pointer-events-none absolute right-3 h-3.5 w-3.5 ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}
              />
            </div>
          )}

          {onShare && (
            <button
              onClick={onShare}
              title={shareTitle}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
                isDark
                  ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800'
                  : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
