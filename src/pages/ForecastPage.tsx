import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cloud, CloudRain, CloudSun, Sun, Moon, Wind, Droplets,
  MapPin, RotateCw, AlertCircle, Sunset, Star, X, RefreshCw,
} from 'lucide-react';
import { getForecast, type ForecastHour, type NightRating } from '../lib/api/planner';
import { getSettings, updateSettings } from '../lib/api/settings';
import { useTheme } from '../hooks/useTheme';
import { LocationPrompt } from '../components/LocationPrompt';

function formatTemp(celsius: number, unit: 'celsius' | 'fahrenheit'): string {
  if (unit === 'fahrenheit') return `${Math.round(celsius * 9 / 5 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}

// ─── Visibility Score Engine ─────────────────────────────────────────

interface VisibilityResult {
  score: number;
  label: string;
  color: string;
  recommendation: string;
  breakdown: { clouds: number; seeing: number; moon: number; transparency: number };
  dewWarning: boolean;
}

// Smooth cloud cover over a ±1 hour window to reduce NWP model noise.
// The raw hourly model output can swing ±50% between adjacent hours for
// partial cloud cover — averaging with neighbors gives a more realistic picture.
function smoothHours(hours: ForecastHour[]): ForecastHour[] {
  return hours.map((h, i) => {
    const values = [hours[i - 1]?.cloudCover, h.cloudCover, hours[i + 1]?.cloudCover]
      .filter((v): v is number => v !== undefined);
    return { ...h, cloudCover: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
  });
}

function calculateVisibilityScore(
  hour: ForecastHour,
  moonIllumination: number,
): VisibilityResult {
  // Cloud Cover (60% weight): 0% = 1.0, 100% = 0.0
  const cloudScore = 1 - hour.cloudCover / 100;

  // Seeing (20% weight): base from 7Timer (interpolated), then apply jet stream + CAPE modifiers.
  // Jet stream (500hPa wind): the primary physical driver of atmospheric seeing.
  //   <40 km/h = minimal penalty, >120 km/h = severe.
  // CAPE: atmospheric instability. >500 J/kg means turbulent, convective air column.
  const seeingMap: Record<number, number> = { 1: 1.0, 2: 0.75, 3: 0.5, 4: 0.2, 5: 0.0 };
  let seeingScore = hour.seeing != null ? (seeingMap[hour.seeing] ?? 0.5) : 0.5;

  if (hour.jetStream != null) {
    const jsPenalty = hour.jetStream < 40 ? 0
      : hour.jetStream < 80 ? 0.12
      : hour.jetStream < 120 ? 0.25
      : 0.40;
    seeingScore = Math.max(0, seeingScore - jsPenalty);
  }
  if (hour.cape != null && hour.cape > 100) {
    const capePenalty = hour.cape < 500 ? 0.05 : hour.cape < 1500 ? 0.10 : 0.15;
    seeingScore = Math.max(0, seeingScore - capePenalty);
  }

  // Moon (20% weight): penalty for high illumination during night hours
  const hourOfDay = new Date(hour.time).getHours();
  const isNight = hourOfDay >= 19 || hourOfDay <= 5;
  const moonPenalty = isNight ? (1 - moonIllumination / 100) : 1.0;

  // Transparency bonus: based on humidity (high humidity = poor transparency)
  const humidityPenalty = Math.max(0, 1 - Math.max(0, hour.humidity - 40) / 60);
  const transparencyBonus = humidityPenalty * 0.1; // up to 10% bonus

  // Dew risk: temp within 3°C of dew point means equipment may dew over
  const dewWarning = (hour.temperature - hour.dewPoint) < 3;

  const raw = (cloudScore * 0.6) + (seeingScore * 0.2) + (moonPenalty * 0.2) + transparencyBonus;
  const score = Math.round(Math.min(100, Math.max(0, raw * 100)));

  let label: string;
  let color: string;
  if (score >= 85) { label = 'Ideal'; color = 'text-emerald-400'; }
  else if (score >= 70) { label = 'Great'; color = 'text-emerald-500'; }
  else if (score >= 55) { label = 'Good'; color = 'text-blue-400'; }
  else if (score >= 40) { label = 'Fair'; color = 'text-amber-400'; }
  else if (score >= 25) { label = 'Poor'; color = 'text-orange-500'; }
  else { label = 'Bad'; color = 'text-red-500'; }

  const recommendation = getRecommendation(score, hour, moonIllumination);

  return {
    score,
    label,
    color,
    recommendation,
    dewWarning,
    breakdown: {
      clouds: Math.round(cloudScore * 100),
      seeing: Math.round(seeingScore * 100),
      moon: Math.round(moonPenalty * 100),
      transparency: Math.round(humidityPenalty * 100),
    },
  };
}

function getRecommendation(score: number, hour: ForecastHour, moonIllumination: number): string {
  if (score < 25) return 'Stay inside - overcast or very poor conditions.';
  if (score < 40) return 'Marginal - maybe bright planets through cloud gaps.';
  if (hour.cloudCover > 50) return 'Partly cloudy - try bright targets like the Moon or planets.';
  if (moonIllumination > 70 && score >= 55) return 'Bright Moon - great for planets, Moon detail, and star clusters. Avoid faint nebulae.';
  if (moonIllumination < 20 && score >= 70) return 'Dark skies - ideal for deep sky: galaxies, nebulae, and faint targets.';
  if (score >= 85) return 'Excellent conditions for any target - deep sky objects, planets, and wide-field.';
  if (score >= 70) return 'Good for most targets - galaxies and brighter nebulae will show well.';
  if (score >= 55) return 'Decent conditions - stick to brighter targets like star clusters and planets.';
  return 'Limited - try bright planets or the Moon.';
}

// ─── Score ring color helpers ────────────────────────────────────────

function scoreRingColor(score: number): string {
  if (score >= 85) return 'stroke-emerald-400';
  if (score >= 70) return 'stroke-emerald-500';
  if (score >= 55) return 'stroke-blue-400';
  if (score >= 40) return 'stroke-amber-400';
  if (score >= 25) return 'stroke-orange-500';
  return 'stroke-red-500';
}

function scoreBgColor(score: number, isDark: boolean): string {
  if (score >= 85) return isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200';
  if (score >= 70) return isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-100';
  if (score >= 55) return isDark ? 'bg-blue-500/5 border-blue-500/20' : 'bg-blue-50/50 border-blue-100';
  if (score >= 40) return isDark ? 'bg-amber-500/5 border-amber-500/20' : 'bg-amber-50/50 border-amber-100';
  return isDark ? 'bg-red-500/5 border-red-500/20' : 'bg-red-50/50 border-red-100';
}

// ─── Main Page ───────────────────────────────────────────────────────

export function ForecastPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const queryClient = useQueryClient();
  const [selectedHour, setSelectedHour] = useState<ForecastHour | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data: appSettings } = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: Infinity });
  const tempUnit = appSettings?.temperatureUnit ?? 'fahrenheit';
  const lat = appSettings?.latitude ?? null;
  const lon = appSettings?.longitude ?? null;
  const locationSet = lat !== null && lon !== null;

  const { data: forecast, isLoading, error } = useQuery({
    queryKey: ['forecast', lat, lon],
    queryFn: () => getForecast(lat!, lon!),
    enabled: lat !== null && lon !== null,
    staleTime: 600_000,
  });

  // Filter to astronomical dark hours only (astro dusk → astro dawn), then smooth cloud cover
  // over adjacent hours to remove NWP model noise before scoring.
  const tonightHours = smoothHours((forecast?.hourly || []).filter(h => {
    if (!forecast) return false;
    const t = new Date(h.time).getTime();
    const darkStart = new Date(forecast.tonight.astronomicalTwilightEnd).getTime();
    const darkEnd = new Date(forecast.tonight.astronomicalTwilightStart).getTime();
    return t >= darkStart - 3600000 && t <= darkEnd + 3600000;
  }));

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            <CloudSun className={`w-7 h-7 ${accentText}`} />
            Sky Forecast
          </h1>
          <p className={`mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Astronomy weather conditions for tonight and upcoming nights
          </p>
        </div>
        {locationSet && (
          <div className={`flex items-center gap-4 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5" />
              <div>
                {appSettings?.locationName && (
                  <div className={`font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    {appSettings.locationName}
                  </div>
                )}
                <div className={`text-xs ${appSettings?.locationName ? '' : 'font-medium'}`}>
                  {lat!.toFixed(2)}, {lon!.toFixed(2)}
                </div>
              </div>
            </div>
            <button
              onClick={async () => {
                setRefreshing(true);
                try {
                  await updateSettings({ latitude: lat!, longitude: lon! });
                  await queryClient.invalidateQueries({ queryKey: ['settings'] });
                  await queryClient.fetchQuery({
                    queryKey: ['forecast', lat, lon],
                    queryFn: () => getForecast(lat!, lon!, true),
                    staleTime: 0,
                  });
                } catch { /* ignore */ }
                setRefreshing(false);
              }}
              disabled={refreshing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                isDark
                  ? 'hover:bg-slate-800 text-slate-400 disabled:opacity-40'
                  : 'hover:bg-slate-100 text-slate-500 disabled:opacity-40'
              }`}
              title="Refresh forecast"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        )}
      </div>

      {/* Location not set — same empty state as Planner; persists to settings */}
      {!locationSet && (
        <LocationPrompt
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          subText={subText}
          description="The forecast needs your latitude and longitude to fetch weather conditions."
          invalidateKeys={[['forecast']]}
        />
      )}

      {isLoading && locationSet && (
        <div className="flex items-center justify-center py-20">
          <RotateCw className="w-6 h-6 animate-spin text-accent-500" />
        </div>
      )}

      {error && (
        <div className={`text-center py-12 rounded-xl border ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
          <AlertCircle className="w-10 h-10 mx-auto mb-3 text-danger-500/50" />
          <p className={isDark ? 'text-slate-400' : 'text-slate-500'}>
            {error instanceof Error ? error.message : 'Failed to load forecast'}
          </p>
          <p className={`mt-2 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Make sure your location is set in Settings, then refresh.
          </p>
        </div>
      )}

      {forecast && (
        <>
          {/* Night ratings overview */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {forecast.nightRatings.map((night, i) => (
              <NightCard key={night.date} night={night} isTonight={i === 0} isDark={isDark} />
            ))}
          </div>

          {/* Tonight's astronomical conditions */}
          <div className={`rounded-2xl border p-6 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
            <h2 className={`font-display text-lg font-semibold mb-4 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              <Moon className="w-5 h-5 inline mr-2 text-accent-500" />
              Tonight's Conditions
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <InfoCard icon={<Moon className="w-4 h-4" />} label="Moon" value={forecast.tonight.moonPhase} sub={`${forecast.tonight.moonIllumination}% illuminated`} isDark={isDark} />
              <InfoCard icon={<Sun className="w-4 h-4" />} label="Dark Hours" value={`${forecast.tonight.darkHours}h`} sub="Astronomical dark" isDark={isDark} />
              <InfoCard icon={<Sunset className="w-4 h-4" />} label="Sunset" value={formatTime(forecast.tonight.sunset)} sub={`Astro dark ${formatTime(forecast.tonight.astronomicalTwilightEnd)}`} isDark={isDark} />
              <InfoCard icon={<Sun className="w-4 h-4" />} label="Sunrise" value={formatTime(forecast.tonight.sunrise)} sub={`Astro dawn ${formatTime(forecast.tonight.astronomicalTwilightStart)}`} isDark={isDark} />
            </div>
          </div>

          {/* Hourly timeline with visibility scores */}
          <div className={`rounded-2xl border p-6 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
            <h2 className={`font-display text-lg font-semibold mb-4 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              <Star className="w-5 h-5 inline mr-2 text-accent-500" />
              Tonight Hour by Hour
            </h2>

            {tonightHours.length > 0 ? (
              <>
                <div className="overflow-x-auto -mx-2">
                  <div className="flex gap-3 px-2 pb-3">
                    {tonightHours.map(h => (
                      <HourColumn
                        key={h.time}
                        hour={h}
                        moonIllumination={forecast.tonight.moonIllumination}
                        isSelected={selectedHour?.time === h.time}
                        onSelect={() => setSelectedHour(selectedHour?.time === h.time ? null : h)}
                        isDark={isDark}
                        tempUnit={tempUnit}
                      />
                    ))}
                  </div>
                </div>

                {/* Expanded recommendation panel */}
                {selectedHour && (
                  <HourDetail
                    hour={selectedHour}
                    moonIllumination={forecast.tonight.moonIllumination}
                    isDark={isDark}
                    onClose={() => setSelectedHour(null)}
                    tempUnit={tempUnit}
                  />
                )}

                <HourlyLegend isDark={isDark} />

                <div className={`text-[11px] mt-3 pt-3 border-t ${isDark ? 'border-slate-800 text-slate-600' : 'border-slate-200 text-slate-400'}`}>
                  Source: {[forecast.sources.weather, forecast.sources.seeing].filter(Boolean).join(', ')}
                </div>
              </>
            ) : (
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                No nighttime hours in forecast window
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Hour Column with Visibility Score ───────────────────────────────

function HourColumn({ hour, moonIllumination, isSelected, onSelect, isDark, tempUnit }: {
  hour: ForecastHour;
  moonIllumination: number;
  isSelected: boolean;
  onSelect: () => void;
  isDark: boolean;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const time = new Date(hour.time);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });

  const vis = calculateVisibilityScore(hour, moonIllumination);

  const cloudColor = hour.cloudCover < 25 ? 'bg-emerald-500' : hour.cloudCover < 50 ? 'bg-blue-500' : hour.cloudCover < 75 ? 'bg-amber-500' : 'bg-red-500';

  // SVG ring for score
  const circumference = 2 * Math.PI * 18;
  const dashOffset = circumference * (1 - vis.score / 100);

  return (
    <button
      onClick={onSelect}
      className={`flex flex-col items-center gap-2.5 flex-1 min-w-[96px] py-4 px-2 rounded-xl transition-all cursor-pointer ${
        isSelected
          ? isDark ? 'bg-slate-800 ring-1 ring-accent-500/40' : 'bg-slate-100 ring-1 ring-accent-400/40'
          : isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
      }`}
    >
      <span className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{timeStr}</span>

      {/* Visibility score ring -the single overall rating */}
      <div className="relative w-14 h-14">
        <svg className="w-14 h-14 -rotate-90" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="18" fill="none" strokeWidth="3"
            className={isDark ? 'stroke-slate-800' : 'stroke-slate-200'} />
          <circle cx="20" cy="20" r="18" fill="none" strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={scoreRingColor(vis.score)} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-base font-bold ${vis.color}`}>{vis.score}</span>
        </div>
      </div>
      <span className={`text-sm font-semibold ${vis.color}`}>{vis.label}</span>

      {/* Cloud cover bar */}
      <div className={`w-full mx-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
        <div
          className={`h-full rounded-full ${cloudColor} transition-all`}
          style={{ width: `${Math.max(hour.cloudCover, 2)}%` }}
        />
      </div>
      <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <Cloud className="w-3 h-3 inline -mt-0.5 mr-0.5" />{hour.cloudCover}%
      </span>

      {/* Temp */}
      <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
        {formatTemp(hour.temperature, tempUnit)}
      </span>
    </button>
  );
}

// ─── Expanded Hour Detail Panel ──────────────────────────────────────

function HourDetail({ hour, moonIllumination, isDark, onClose, tempUnit }: {
  hour: ForecastHour;
  moonIllumination: number;
  isDark: boolean;
  onClose: () => void;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const vis = calculateVisibilityScore(hour, moonIllumination);
  const time = new Date(hour.time);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <div className={`mt-4 p-5 rounded-xl border transition-all ${scoreBgColor(vis.score, isDark)}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-display font-bold ${vis.color}`}>{vis.score}</span>
            <div>
              <span className={`text-sm font-semibold ${vis.color}`}>{vis.label}</span>
              <span className={`text-sm ml-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{timeStr}</span>
            </div>
          </div>
        </div>
        <button onClick={onClose} className={`p-1 rounded-lg ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-200'}`}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Recommendation */}
      <div className={`p-3 rounded-lg mb-4 ${isDark ? 'bg-slate-900/50' : 'bg-white/70'}`}>
        <div className="flex items-start gap-2">
          <Star className={`w-4 h-4 shrink-0 mt-0.5 ${vis.color}`} />
          <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {vis.recommendation}
          </p>
        </div>
      </div>

      {/* Score breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <BreakdownBar label="Clouds" value={vis.breakdown.clouds} detail={`${hour.cloudCover}% cover`} isDark={isDark} />
        <BreakdownBar label="Seeing" value={vis.breakdown.seeing} detail={hour.seeing ? ['', 'Excellent', 'Good', 'Average', 'Poor', 'Bad'][hour.seeing] : 'N/A'} isDark={isDark} />
        <BreakdownBar label="Moon" value={vis.breakdown.moon} detail={`${moonIllumination}% lit`} isDark={isDark} />
        <BreakdownBar label="Transparency" value={vis.breakdown.transparency} detail={`${hour.humidity}% humidity`} isDark={isDark} />
      </div>

      {/* Extra details */}
      <div className={`flex flex-wrap gap-x-6 gap-y-1 mt-4 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <span><Wind className="w-3 h-3 inline mr-1" />{Math.round(hour.wind * 0.621371)} mph</span>
        <span><Droplets className="w-3 h-3 inline mr-1" />Dew pt {formatTemp(hour.dewPoint, tempUnit)}</span>
        <span>Temp {formatTemp(hour.temperature, tempUnit)}</span>
        {hour.jetStream != null && (
          <span title="500hPa jet stream — high speeds cause poor seeing">
            Jet {Math.round(hour.jetStream)} km/h
          </span>
        )}
        {hour.cape != null && hour.cape > 50 && (
          <span title="Convective Available Potential Energy — high = unstable atmosphere">
            CAPE {Math.round(hour.cape)} J/kg
          </span>
        )}
        {hour.precipProb > 0 && <span className="text-amber-500"><CloudRain className="w-3 h-3 inline mr-1" />{hour.precipProb}% precip</span>}
      </div>

      {/* Dew warning */}
      {vis.dewWarning && (
        <div className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${isDark ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
          <Droplets className="w-3.5 h-3.5 shrink-0" />
          Dew risk: temp ({formatTemp(hour.temperature, tempUnit)}) is within 3° of dew point. Consider dew heaters.
        </div>
      )}
    </div>
  );
}

function BreakdownBar({ label, value, detail, isDark }: {
  label: string;
  value: number;
  detail: string;
  isDark: boolean;
}) {
  const barColor = value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-blue-500' : value >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</span>
        <span className={`text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{value}</span>
      </div>
      <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{detail}</span>
    </div>
  );
}

// ─── Supporting Components ───────────────────────────────────────────

function NightCard({ night, isTonight, isDark }: { night: NightRating; isTonight: boolean; isDark: boolean }) {
  const scoreColor = night.score >= 80 ? 'text-emerald-500' : night.score >= 60 ? 'text-blue-500' : night.score >= 40 ? 'text-amber-500' : night.score >= 20 ? 'text-orange-500' : 'text-red-500';
  const bgRing = 'ring-amber-500/30';

  const dateLabel = isTonight
    ? 'Tonight'
    : new Date(night.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className={`rounded-2xl border p-5 transition ${isTonight ? `ring-2 ${bgRing}` : ''} ${
      isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{dateLabel}</p>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-display font-bold ${scoreColor}`}>{night.score}</p>
          <p className={`text-xs font-medium ${scoreColor}`}>{night.rating}</p>
        </div>
      </div>

      <div className={`space-y-1.5 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1"><Cloud className="w-3 h-3" /> Clouds</span>
          <span className={night.avgCloudCover > 50 ? 'text-amber-500' : ''}>{night.avgCloudCover}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1"><Droplets className="w-3 h-3" /> Humidity</span>
          <span>{night.avgHumidity}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1"><Wind className="w-3 h-3" /> Wind</span>
          <span>{Math.round(night.avgWind * 0.621371)} mph</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1"><CloudRain className="w-3 h-3" /> Precip</span>
          <span className={night.precipChance > 30 ? 'text-danger-500' : ''}>{night.precipChance}%</span>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ icon, label, value, sub, isDark }: { icon: React.ReactNode; label: string; value: string; sub: string; isDark: boolean }) {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-50'}`}>
      <div className={`flex items-center gap-2 mb-1.5 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        {icon}
        {label}
      </div>
      <p className={`font-semibold text-lg ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{value}</p>
      <p className={`text-sm mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{sub}</p>
    </div>
  );
}

function HourlyLegend({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 mt-4 pt-4 border-t text-xs ${
      isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
    }`}>
      <div className="flex items-center gap-2">
        <span className={`font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Rating</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />85+ Ideal</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-blue-400" />55+ Good</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" />40+ Fair</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500" />&lt;25 Bad</span>
      </div>
      <div className={`${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
        Score combines cloud cover (60%), seeing + jet stream (20%), moon (20%), and humidity. Tap an hour for details.
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return '-';
  }
}
