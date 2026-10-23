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
import { useTranslation } from 'react-i18next';
import { Cloud, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { MoonDisk } from '../ui/MoonDisk';
import { Fact, FactGrid, PanelEmpty, SessionPanel } from '../ui/Panel';
import { cloudVerdict } from '../../lib/cloudVerdict';
import type { SessionWeather } from '../../types';

export interface SkyConditions {
  bortleClass?: number | null;
  seeingRating?: number | null;
  transparencyRating?: number | null;
  moonPhase?: string | null;
  moonIllumination?: number | null;
}

export function ConditionsPanel({ weather, sky, tempUnit }: {
  weather: SessionWeather | null | undefined;
  sky?: SkyConditions | null;
  tempUnit: 'celsius' | 'fahrenheit';
}) {
  const { isDark, isNight } = useTheme();
  const { t } = useTranslation('observations');

  const temp = (c: number) =>
    tempUnit === 'fahrenheit' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;

  const hasSky = !!sky && (
    sky.bortleClass != null || sky.seeingRating != null
    || sky.transparencyRating != null || !!sky.moonPhase
  );
  const cloud = weather?.cloudCover;
  const verdict = cloud != null ? cloudVerdict(cloud, t, isNight) : null;

  const weatherFacts: { label: string; value: string }[] = [];
  if (weather?.temperature != null) weatherFacts.push({ label: t('observationDetail.conditionsPanel.airTemp'), value: temp(weather.temperature) });
  if (weather?.humidity != null) weatherFacts.push({ label: t('observationDetail.conditionsPanel.humidity'), value: `${Math.round(weather.humidity)}%` });
  if (weather?.windSpeed != null) weatherFacts.push({ label: t('observationDetail.conditionsPanel.wind'), value: `${Math.round(weather.windSpeed * 0.621371)} mph` });
  if (weather?.dewPoint != null) weatherFacts.push({ label: t('observationDetail.conditionsPanel.dewPoint'), value: temp(weather.dewPoint) });
  if (weather?.precipProb != null && weather.precipProb > 0) {
    weatherFacts.push({ label: t('observationDetail.conditionsPanel.precipitation'), value: `${Math.round(weather.precipProb)}%` });
  }

  const skyFacts: { label: string; value: string }[] = [];
  if (sky?.bortleClass != null) skyFacts.push({ label: t('observationDetail.conditionsPanel.bortle'), value: t('observationDetail.conditionsPanel.bortleClass', { value: sky.bortleClass }) });
  if (sky?.seeingRating != null) skyFacts.push({ label: t('observationDetail.conditionsPanel.seeing'), value: t('observationDetail.conditionsPanel.ratingOutOf5', { value: sky.seeingRating }) });
  if (sky?.transparencyRating != null) skyFacts.push({ label: t('observationDetail.conditionsPanel.transparency'), value: t('observationDetail.conditionsPanel.ratingOutOf5', { value: sky.transparencyRating }) });

  const rule = isDark ? 'border-slate-800' : 'border-slate-100';

  return (
    <SessionPanel title={t('observationDetail.conditionsPanel.title')} icon={Cloud}>
      {!weather && !hasSky && (
        <PanelEmpty>
          {t('observationDetail.conditionsPanel.empty')}
        </PanelEmpty>
      )}

      {(verdict != null || sky?.moonPhase) && (
        <div className="flex items-center gap-5">
          {verdict && cloud != null && (
            <div className="min-w-0 flex-1">
              <div
                className="font-display text-[2.125rem] font-bold leading-none tracking-tight tabular-nums"
                style={{ color: verdict.hex }}
              >
                {Math.round(cloud)}<span className="text-xl align-top">%</span>
              </div>
              <div className={`mt-1.5 text-[0.8125rem] font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                {verdict.label}
              </div>
              <div className={`text-[0.6562rem] font-medium uppercase tracking-[0.12em] ${
                isDark ? 'text-slate-500' : 'text-slate-400'
              }`}>
                {t('observationDetail.conditionsPanel.cloudCover')}
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
                style={{ background: isNight ? 'radial-gradient(circle, #2a0808 0%, #000000 100%)' : 'radial-gradient(circle, #1e293b 0%, #020617 100%)' }}
              >
                <MoonDisk
                  illumination={sky.moonIllumination ?? 0}
                  phase={sky.moonPhase}
                  size={42}
                />
              </div>
              <div className="min-w-0 leading-tight">
                <div className={`flex items-center gap-1 text-[0.6562rem] font-medium uppercase tracking-[0.12em] ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  <Moon className="h-3 w-3" />
                  {t('observationDetail.conditionsPanel.moon')}
                </div>
                <div className={`mt-1 text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {sky.moonPhase}
                </div>
                {sky.moonIllumination != null && (
                  <div className={`text-[0.7188rem] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {t('observationDetail.conditionsPanel.moonLit', { percent: Math.round(sky.moonIllumination) })}
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
