/**
 * One of the nights ahead. Tonight is not shown here: it gets the hero panel,
 * and repeating it with the server's coarser night rating would put two
 * different numbers for the same night on one screen.
 *
 * The sparkline is drawn from the same hourly model data the hero uses, so the
 * card shows the shape of the cloud cover, not just its average.
 */
import { Cloud, CloudRain, Droplets, Wind } from 'lucide-react';
import type { ForecastHour, NightRating } from '../../lib/api/planner';
import { formatWind, scoreHex } from '../../lib/forecastScore';

interface Props {
  night: NightRating;
  /** Hours belonging to this night, already filtered by the caller. */
  hours: ForecastHour[];
  isDark: boolean;
  windUnit: 'mph' | 'kmh';
  timeZone?: string;
}

/** timeZone is a site record or forecast-response value, not authored by
 *  this component — Intl throws synchronously on one it can't parse, so
 *  fall back to formatting in the device's own zone rather than crash. */
function safeLocaleDateString(d: Date, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): string {
  try {
    return d.toLocaleDateString('en-US', { ...options, ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toLocaleDateString('en-US', options);
  }
}

/** Cloud cover across the night, drawn top-down so more ink means more cloud. */
function CloudSparkline({ hours, isDark }: { hours: ForecastHour[]; isDark: boolean }) {
  if (hours.length < 2) return null;
  const W = 100;
  const H = 26;
  const pts = hours.map((h, i) => ({
    x: (i / (hours.length - 1)) * W,
    y: (Math.min(100, Math.max(0, h.cloudCover)) / 100) * H,
  }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L ${W},0 L 0,0 Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-7 w-full" aria-hidden="true">
      <path d={area} fill={isDark ? 'rgba(148,163,184,0.28)' : 'rgba(100,116,139,0.20)'} />
      <path
        d={line}
        fill="none"
        stroke={isDark ? 'rgba(203,213,225,0.65)' : 'rgba(71,85,105,0.55)'}
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Metric({ icon, label, value, warn, isDark }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  warn?: boolean;
  isDark: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        {icon}
        {label}
      </span>
      <span className={`tabular-nums font-medium ${
        warn ? 'text-amber-500' : isDark ? 'text-slate-300' : 'text-slate-600'
      }`}>
        {value}
      </span>
    </div>
  );
}

export function NightOutlookCard({ night, hours, isDark, windUnit, timeZone }: Props) {
  const hex = scoreHex(night.score);
  const lowConfidence = night.confidence === 'low';

  const date = new Date(night.date + 'T12:00:00');
  const weekday = safeLocaleDateString(date, timeZone, { weekday: 'long' });
  const dayLabel = safeLocaleDateString(date, timeZone, { month: 'short', day: 'numeric' });

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border p-5 transition-transform duration-300 ease-out hover:-translate-y-0.5 ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      } ${lowConfidence ? 'opacity-80' : ''}`}
    >
      {/* Score-tinted wash so a run of good nights is visible without reading. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-40 transition-opacity duration-300 group-hover:opacity-70"
        style={{ background: `radial-gradient(100% 100% at 82% 0%, ${hex}26 0%, transparent 72%)` }}
      />

      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`font-display text-lg font-semibold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              {weekday}
            </p>
            <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{dayLabel}</p>
          </div>
          <div className="text-right leading-none">
            <p
              className="font-display text-3xl font-bold tabular-nums"
              style={{ color: hex, textShadow: `0 0 20px ${hex}45` }}
            >
              {night.score}
            </p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: hex }}>
              {night.rating}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div className={`mb-1 text-[10.5px] font-medium uppercase tracking-[0.14em] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            Cloud cover through the night
          </div>
          <CloudSparkline hours={hours} isDark={isDark} />
        </div>

        <div className="mt-4 space-y-1.5 text-xs">
          <Metric isDark={isDark} icon={<Cloud className="h-3 w-3" />} label="Clouds" value={`${night.avgCloudCover}%`} warn={night.avgCloudCover > 50} />
          <Metric isDark={isDark} icon={<Droplets className="h-3 w-3" />} label="Humidity" value={`${night.avgHumidity}%`} />
          <Metric isDark={isDark} icon={<Wind className="h-3 w-3" />} label="Wind" value={formatWind(night.avgWind, windUnit)} />
          <Metric isDark={isDark} icon={<CloudRain className="h-3 w-3" />} label="Precip" value={`${night.precipChance}%`} warn={night.precipChance > 30} />
        </div>
      </div>
    </div>
  );
}
