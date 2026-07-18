import { Cloud, Thermometer, Droplets, Wind } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionWeather } from '../../types';

export function WeatherPanel({ weather, tempUnit }: {
  weather: SessionWeather;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  return (
    <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <h3 className={`font-display font-semibold text-sm flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
        <Cloud className={`w-3.5 h-3.5 ${accentText}`} />
        Weather Conditions
      </h3>
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
    </div>
  );
}
