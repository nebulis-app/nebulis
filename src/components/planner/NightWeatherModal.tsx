/**
 * The full weather picture for the night being planned, without leaving the
 * planner.
 *
 * This is the Sky Forecast page's content, scoped to the selected night rather
 * than always to tonight: the same hero, the same night ribbon, the same hour
 * breakdown, the same outlook cards, all from the same components. Nothing is
 * re-implemented here, so the two surfaces cannot drift apart, and the planner
 * is on its way to being the only place you need.
 *
 * The night panel and the timeline's weather gutter both open this. Opening it
 * from a gutter hour lands on that hour's breakdown.
 */
import { useState } from 'react';
import { CloudSun, RefreshCw, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { TonightHero } from '../forecast/TonightHero';
import { HourDetail } from '../forecast/HourDetail';
import { NightOutlookCard } from '../forecast/NightOutlookCard';
import { RatingLegend } from '../ui/RatingLegend';
import { hoursForNight } from '../../lib/forecastNights';
import type { DarkWindow } from '../../lib/forecastScore';
import type { ForecastHour, NightRating } from '../../lib/api/planner';

/** The shape TonightHero and NightRibbon need to draw a night end to end. */
export interface NightAstro {
  moonIllumination: number;
  moonPhase: string;
  moonRise: string | null;
  moonSet: string | null;
  sunset: string;
  sunrise: string;
  astronomicalTwilightEnd: string;
  astronomicalTwilightStart: string;
  nauticalTwilightEnd: string;
  nauticalTwilightStart: string;
  darkHours: number;
  nauticalDarkHours: number;
}

interface Props {
  /** The night being planned, for the dialog's title. */
  date: Date;
  isToday: boolean;
  /** Hourly forecast covering this night, already filtered by the caller. */
  hours: ForecastHour[];
  astro: NightAstro;
  darkWindow: DarkWindow | null;
  /** Every hour the forecast knows about, for the outlook cards below. */
  allHours: ForecastHour[];
  nightRatings: NightRating[];
  /** YYYY-MM-DD of the night on show, so the outlook can skip it. */
  selectedDateKey: string;
  timeZone?: string;
  tempUnit: 'celsius' | 'fahrenheit';
  windUnit: 'mph' | 'kmh';
  accent: string;
  isDark: boolean;
  /** ISO time of the hour to open on, when launched from the gutter. */
  initialHourTime?: string | null;
  onRefresh: () => void | Promise<void>;
  isRefreshing: boolean;
  onClose: () => void;
}

export function NightWeatherModal({
  date,
  isToday,
  hours,
  astro,
  darkWindow,
  allHours,
  nightRatings,
  selectedDateKey,
  timeZone,
  tempUnit,
  windUnit,
  accent,
  isDark,
  initialHourTime,
  onRefresh,
  isRefreshing,
  onClose,
}: Props) {
  // Seeded once: the dialog is only mounted while open, and its backdrop
  // covers the gutter, so the launching hour cannot change underneath it.
  const [selectedHour, setSelectedHour] = useState<ForecastHour | null>(
    () => hours.find(h => h.time === initialHourTime) ?? null,
  );

  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const upcoming = nightRatings.filter(n => n.date > selectedDateKey);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Weather for ${dateLabel}`}
      focusOnOpen="dialog"
      className={`flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl shadow-2xl ${
        isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'
      }`}
    >
      <div className={`flex items-center gap-3 border-b px-5 py-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <CloudSun className={`h-5 w-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold leading-tight">
            {isToday ? "Tonight's weather" : 'Weather for this night'}
          </h2>
          <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{dateLabel}</p>
        </div>
        <button
          onClick={() => void onRefresh()}
          disabled={isRefreshing}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
            isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-200'
          }`}
          title="Fetch the latest forecast"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        <button
          onClick={onClose}
          className={`rounded-lg p-2 transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-200'}`}
          aria-label="Close weather"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {hours.length > 1 ? (
          <TonightHero
            hours={hours}
            tonight={astro}
            timeZone={timeZone}
            darkWindow={darkWindow}
            tempUnit={tempUnit}
            selectedTime={selectedHour?.time ?? null}
            onSelect={(h) => setSelectedHour(prev => (prev?.time === h.time ? null : h))}
            accent={accent}
          />
        ) : (
          <div className={`rounded-2xl border p-6 text-sm ${
            isDark ? 'border-slate-800 bg-slate-900 text-slate-500' : 'border-slate-200 bg-white text-slate-400'
          }`}>
            No hourly forecast reaches this night yet. The outlook runs a few days ahead.
          </div>
        )}

        {selectedHour && (
          <HourDetail
            hour={selectedHour}
            moonIllumination={astro.moonIllumination}
            isDark={isDark}
            onClose={() => setSelectedHour(null)}
            tempUnit={tempUnit}
            windUnit={windUnit}
            timeZone={timeZone}
            darkWindow={darkWindow}
          />
        )}

        {hours.length > 1 && <RatingLegend isDark={isDark} />}

        {upcoming.length > 0 && (
          <div>
            <h3 className={`mb-3 font-display text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              The nights after this one
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {upcoming.map(night => (
                <NightOutlookCard
                  key={night.date}
                  night={night}
                  hours={hoursForNight(allHours, night.date, timeZone)}
                  isDark={isDark}
                  windUnit={windUnit}
                  timeZone={timeZone}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
