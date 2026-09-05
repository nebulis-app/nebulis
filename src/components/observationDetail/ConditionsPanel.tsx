/**
 * What the sky was doing on the night of this session.
 *
 * Two sources, one card. The weather half is the forecast recorded at the
 * capture location; the sky half is what the observer graded by eye. They were
 * two cards of four small key/value rows each, which buried the one number that
 * decides whether a night was any good. Cloud cover now leads at a readable
 * size and takes its colour from the value, the Moon is drawn at its real phase
 * (the same disk the Forecast and Planner use) rather than named in a row, and
 * everything else follows as ordinary facts.
 */
import { Cloud, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { MoonDisk } from '../ui/MoonDisk';
import { Fact, FactGrid, PanelEmpty, SessionPanel } from '../ui/Panel';
import type { SessionWeather } from '../../types';

export interface SkyConditions {
  bortleClass?: number | null;
  seeingRating?: number | null;
  transparencyRating?: number | null;
  moonPhase?: string | null;
  moonIllumination?: number | null;
}

/**
 * Cloud cover, coloured as a verdict. Less is better, so this runs the opposite
 * way to most bars: clear is the good end. The three steps are the same
 * traffic-light the planner uses for a scheduled block.
 */
function cloudVerdict(pct: number): { label: string; hex: string } {
  if (pct <= 15) return { label: 'Clear', hex: '#10b981' };
  if (pct <= 40) return { label: 'Mostly clear', hex: '#34d399' };
  if (pct <= 70) return { label: 'Broken cloud', hex: '#f59e0b' };
  return { label: 'Overcast', hex: '#ef4444' };
}

export function ConditionsPanel({ weather, sky, tempUnit }: {
  weather: SessionWeather | null | undefined;
  sky?: SkyConditions | null;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark } = useTheme();

  const temp = (c: number) =>
    tempUnit === 'fahrenheit' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;

  const hasSky = !!sky && (
    sky.bortleClass != null || sky.seeingRating != null
    || sky.transparencyRating != null || !!sky.moonPhase
  );
  const cloud = weather?.cloudCover;
  const verdict = cloud != null ? cloudVerdict(cloud) : null;

  const weatherFacts: { label: string; value: string }[] = [];
  if (weather?.temperature != null) weatherFacts.push({ label: 'Air temp', value: temp(weather.temperature) });
  if (weather?.humidity != null) weatherFacts.push({ label: 'Humidity', value: `${Math.round(weather.humidity)}%` });
  if (weather?.windSpeed != null) weatherFacts.push({ label: 'Wind', value: `${Math.round(weather.windSpeed * 0.621371)} mph` });
  if (weather?.dewPoint != null) weatherFacts.push({ label: 'Dew point', value: temp(weather.dewPoint) });
  if (weather?.precipProb != null && weather.precipProb > 0) {
    weatherFacts.push({ label: 'Precipitation', value: `${Math.round(weather.precipProb)}%` });
  }

  const skyFacts: { label: string; value: string }[] = [];
  if (sky?.bortleClass != null) skyFacts.push({ label: 'Bortle', value: `Class ${sky.bortleClass}` });
  if (sky?.seeingRating != null) skyFacts.push({ label: 'Seeing', value: `${sky.seeingRating} / 5` });
  if (sky?.transparencyRating != null) skyFacts.push({ label: 'Transparency', value: `${sky.transparencyRating} / 5` });

  const rule = isDark ? 'border-slate-800' : 'border-slate-100';

  return (
    <SessionPanel title="Conditions" icon={Cloud}>
      {!weather && !hasSky && (
        <PanelEmpty>
          No conditions were recorded for this night. Weather is fetched for the session's location
          when it is imported.
        </PanelEmpty>
      )}

      {(verdict != null || sky?.moonPhase) && (
        <div className="flex items-center gap-5">
          {verdict && cloud != null && (
            <div className="min-w-0 flex-1">
              <div
                className="font-display text-[34px] font-bold leading-none tracking-tight tabular-nums"
                style={{ color: verdict.hex }}
              >
                {Math.round(cloud)}<span className="text-xl align-top">%</span>
              </div>
              <div className={`mt-1.5 text-[13px] font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                {verdict.label}
              </div>
              <div className={`text-[10.5px] font-medium uppercase tracking-[0.12em] ${
                isDark ? 'text-slate-500' : 'text-slate-400'
              }`}>
                Cloud cover
              </div>
            </div>
          )}

          {sky?.moonPhase && (
            <div className="flex shrink-0 items-center gap-3">
              {/* The disk draws its unlit limb dark, which on a light card
                  reads as a black ball rather than a moon. A night-sky backing
                  gives it something to be dark against in either theme. */}
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
                style={{ background: 'radial-gradient(circle, #1e293b 0%, #020617 100%)' }}
              >
                <MoonDisk
                  illumination={sky.moonIllumination ?? 0}
                  phase={sky.moonPhase}
                  size={42}
                />
              </div>
              <div className="min-w-0 leading-tight">
                <div className={`flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.12em] ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  <Moon className="h-3 w-3" />
                  Moon
                </div>
                <div className={`mt-1 text-[13px] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {sky.moonPhase}
                </div>
                {sky.moonIllumination != null && (
                  <div className={`text-[11.5px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {Math.round(sky.moonIllumination)}% lit
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {weatherFacts.length > 0 && (
        <FactGrid className={verdict || sky?.moonPhase ? `mt-5 border-t pt-4 ${rule}` : ''}>
          {weatherFacts.map(f => <Fact key={f.label} label={f.label} value={f.value} />)}
        </FactGrid>
      )}

      {skyFacts.length > 0 && (
        <FactGrid className={`mt-4 border-t pt-4 ${rule}`}>
          {skyFacts.map(f => <Fact key={f.label} label={f.label} value={f.value} />)}
        </FactGrid>
      )}
    </SessionPanel>
  );
}
