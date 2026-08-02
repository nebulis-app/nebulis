import { Cloud, Thermometer, Droplets, Wind, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionWeather } from '../../types';

/** The sky-quality half of the panel, recorded by the observer rather than
 *  fetched from the forecast. */
export interface SkyConditions {
  bortleClass?: number | null;
  seeingRating?: number | null;
  transparencyRating?: number | null;
  moonPhase?: string | null;
  moonIllumination?: number | null;
}

/**
 * Forecast weather and observer-recorded sky quality, in one card.
 *
 * These were two separate cards ("Weather Conditions" and "Sky Conditions")
 * holding four small facts each. They answer the same question, so they share
 * a card and are separated by a rule instead of a second border and heading.
 */
export function WeatherPanel({ weather, sky, tempUnit }: {
  weather: SessionWeather | null | undefined;
  sky?: SkyConditions | null;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const hasSky = !!sky && (
    sky.bortleClass != null || sky.seeingRating != null
    || sky.transparencyRating != null || !!sky.moonPhase
  );
  if (!weather && !hasSky) return null;

  return (
    <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
        <Cloud className={`w-3.5 h-3.5 ${accentText}`} />
        Conditions
      </h3>
      {weather && (
      <div className={`grid grid-cols-2 gap-x-4 gap-y-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {weather.cloudCover != null && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              <Cloud className="w-3 h-3" /> Clouds
            </span>
            <span className="font-medium">{Math.round(weather.cloudCover)}%</span>
          </div>
        )}
        {weather.temperature != null && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              <Thermometer className="w-3 h-3" /> Temp
            </span>
            <span className="font-medium">{tempUnit === 'fahrenheit' ? `${Math.round(weather.temperature! * 9 / 5 + 32)}°F` : `${Math.round(weather.temperature!)}°C`}</span>
          </div>
        )}
        {weather.humidity != null && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              <Droplets className="w-3 h-3" /> Humidity
            </span>
            <span className="font-medium">{Math.round(weather.humidity)}%</span>
          </div>
        )}
        {weather.windSpeed != null && (
          <div className="flex items-center justify-between">
            <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              <Wind className="w-3 h-3" /> Wind
            </span>
            <span className="font-medium">{Math.round(weather.windSpeed * 0.621371)} mph</span>
          </div>
        )}
        {weather.dewPoint != null && (
          <div className="flex items-center justify-between">
            <span className={`${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Dew Point</span>
            <span className="font-medium">{tempUnit === 'fahrenheit' ? `${Math.round(weather.dewPoint! * 9 / 5 + 32)}°F` : `${Math.round(weather.dewPoint!)}°C`}</span>
          </div>
        )}
        {weather.precipProb != null && weather.precipProb > 0 && (
          <div className="flex items-center justify-between">
            <span className={`${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Precip</span>
            <span className="font-medium">{Math.round(weather.precipProb)}%</span>
          </div>
        )}
      </div>
      )}

      {hasSky && sky && (
        <div className={`grid grid-cols-2 gap-x-4 gap-y-2 text-xs ${
          weather ? `mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}` : ''
        } ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {sky.bortleClass != null && (
            <div className="flex items-center justify-between">
              <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Bortle</span>
              <span className="font-medium">Class {sky.bortleClass}</span>
            </div>
          )}
          {sky.seeingRating != null && (
            <div className="flex items-center justify-between">
              <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Seeing</span>
              <span className="font-medium">{sky.seeingRating}/5</span>
            </div>
          )}
          {sky.transparencyRating != null && (
            <div className="flex items-center justify-between">
              <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>Transparency</span>
              <span className="font-medium">{sky.transparencyRating}/5</span>
            </div>
          )}
          {sky.moonPhase && (
            <div className="flex items-center justify-between">
              <span className={`flex items-center gap-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                <Moon className="w-3 h-3" /> Moon
              </span>
              <span className="font-medium">
                {sky.moonPhase}
                {sky.moonIllumination != null && ` (${sky.moonIllumination}%)`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
