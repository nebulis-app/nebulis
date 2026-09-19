/**
 * Home / Dashboard page.
 *
 * A single-screen summary of "what's up tonight" for the active observing
 * site.  Three sections, all drawn from data already used by the Forecast and
 * Planner pages:
 *
 *   1. Night Overview   — merged Sky Conditions + Sun & Moon: sunset/sunrise,
 *      moon phase, dark-window hours, Bortle class.
 *   2. Weather Tonight  — hour-by-hour conditions during the dark window
 *      (same engine as the Forecast page's ImagingWindow from PR#15).
 *   3. Tonight's Easy Targets — top 10 DSOs from the planner catalog as
 *      photo tiles, ranked by bestTonightScore.
 *
 * All data is fetched from existing API endpoints; no new backend work needed.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Home, RotateCw } from 'lucide-react';
import { getForecastForSite } from '../lib/api/planner';
import { getSettings } from '../lib/api/settings';
import { getSites, getActiveSite, setActiveSite, type ObservingSite } from '../lib/api/sites';
import { useTheme } from '../hooks/useTheme';
import { LocationPrompt } from '../components/LocationPrompt';
import { SitePicker } from '../components/SitePicker';
import { smoothHours, type DarkWindow } from '../lib/forecastScore';
import { WeatherNight } from '../components/home/WeatherNight';
import { NightOverview } from '../components/home/NightOverview';
import { TonightTargets } from '../components/home/TonightTargets';

export function HomePage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const queryClient = useQueryClient();
  const [pickedSiteId, setPickedSiteId] = useState<string | null>(null);

  // App-wide unit preferences
  const { data: appSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: Infinity,
  });
  const tempUnit = appSettings?.temperatureUnit ?? 'fahrenheit';
  const windUnit = appSettings?.windSpeedUnit ?? 'mph';

  // Observing sites — same pattern as ForecastPage and PlannerPage
  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: getSites,
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const activeSiteQuery = useQuery({
    queryKey: ['active-site'],
    queryFn: getActiveSite,
    staleTime: 0,
  });
  const sites = sitesQuery.data ?? [];
  const effectiveSiteId = pickedSiteId ?? activeSiteQuery.data?.id ?? null;
  const currentSite: ObservingSite | null =
    sites.find(s => s.id === effectiveSiteId) ?? activeSiteQuery.data ?? null;

  const setActiveSiteMut = useMutation({
    mutationFn: (siteId: string) => setActiveSite(siteId),
    onSuccess: (site) => {
      setPickedSiteId(site.id);
      queryClient.invalidateQueries({ queryKey: ['active-site'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['forecast'] });
    },
  });

  const lat = currentSite?.latitude ?? null;
  const lon = currentSite?.longitude ?? null;
  const locationSet = lat !== null && lon !== null;

  const { data: forecast, isLoading, error } = useQuery({
    queryKey: ['forecast', effectiveSiteId],
    queryFn: () => getForecastForSite(effectiveSiteId!),
    enabled: effectiveSiteId != null && locationSet,
    staleTime: 600_000,
  });

  const tz = forecast?.timezone || currentSite?.timezone || undefined;

  // Dark window for scoring (astronomical twilight, fall back to nautical)
  const darkWindow: DarkWindow | null = useMemo(() => {
    if (!forecast) return null;
    const s =
      forecast.tonight.astronomicalTwilightEnd ||
      forecast.tonight.nauticalTwilightEnd;
    const e =
      forecast.tonight.astronomicalTwilightStart ||
      forecast.tonight.nauticalTwilightStart;
    if (!s || !e) return null;
    return { start: new Date(s).getTime(), end: new Date(e).getTime() };
  }, [forecast]);

  // Hourly window: fall back to sunset→sunrise when no astronomical dark exists
  const hourlyWindow: DarkWindow | null = useMemo(() => {
    if (!forecast) return null;
    if (darkWindow) return darkWindow;
    const s = forecast.tonight.sunset;
    const e = forecast.tonight.sunrise;
    if (!s || !e) return null;
    return { start: new Date(s).getTime(), end: new Date(e).getTime() };
  }, [forecast, darkWindow]);

  // Hourly strip filtered to the dark window (±1 h buffer, smoothed)
  const tonightHours = useMemo(
    () =>
      smoothHours(
        (forecast?.hourly ?? []).filter(h => {
          if (!hourlyWindow) return false;
          const t = new Date(h.time).getTime();
          return (
            t >= hourlyWindow.start - 3_600_000 &&
            t <= hourlyWindow.end + 3_600_000
          );
        }),
      ),
    [forecast, hourlyWindow],
  );

  const sitePicker = locationSet && (
    <SitePicker
      isDark={isDark}
      accentText={accentText}
      sites={sites}
      currentSite={currentSite}
      fallbackLabel={
        lat != null && lon != null ? `${lat.toFixed(2)}, ${lon.toFixed(2)}` : ''
      }
      onSelect={id => setActiveSiteMut.mutate(id)}
      isSwitching={setActiveSiteMut.isPending}
    />
  );

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Home
            className={`h-5 w-5 shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
          />
          <div>
            <h1
              className={`font-display text-xl font-bold leading-tight ${
                isDark ? 'text-slate-100' : 'text-slate-800'
              }`}
            >
              Tonight
            </h1>
            <p className={`text-[12px] mt-0.5 ${subText}`}>
              What's up tonight
            </p>
          </div>
        </div>
        {sitePicker}
      </div>

      {/* Location not set */}
      {!locationSet && !sitesQuery.isLoading && !activeSiteQuery.isLoading && (
        <LocationPrompt
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          subText={subText}
          description="The dashboard needs your latitude and longitude to fetch tonight's data."
          invalidateKeys={[['forecast']]}
        />
      )}

      {/* Forecast loading */}
      {isLoading && locationSet && (
        <div className="flex items-center justify-center py-20">
          <RotateCw className="w-6 h-6 animate-spin text-accent-500" />
        </div>
      )}

      {/* Forecast error */}
      {error && !isLoading && (
        <div
          className={`text-center py-12 rounded-2xl border ${
            isDark
              ? 'bg-slate-900 border-slate-800'
              : 'bg-white border-slate-200'
          }`}
        >
          <AlertCircle className="w-10 h-10 mx-auto mb-3 text-danger-500/50" />
          <p className={isDark ? 'text-slate-400' : 'text-slate-500'}>
            {error instanceof Error ? error.message : 'Failed to load forecast'}
          </p>
          <p className={`mt-2 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Make sure your location is set in Settings, then refresh.
          </p>
        </div>
      )}

      {/* Dashboard sections — only once the forecast has resolved */}
      {forecast && (
        <>
          {/* Top row: What's Up Tonight (1/3) + Weather Tonight (2/3) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
            {/* 1/3 — sky overview */}
            <div className="lg:col-span-1 flex flex-col">
              <NightOverview
                tonight={forecast.tonight}
                hours={tonightHours}
                darkWindow={darkWindow}
                site={currentSite}
                timeZone={tz}
                isDark={isDark}
              />
            </div>

            {/* 2/3 — hour-by-hour weather */}
            {tonightHours.length > 1 && (
              <div className="lg:col-span-2 flex flex-col">
                <WeatherNight
                  hours={tonightHours}
                  tonight={forecast.tonight}
                  timeZone={tz}
                  darkWindow={darkWindow}
                  tempUnit={tempUnit}
                  windUnit={windUnit}
                  isDark={isDark}
                />
              </div>
            )}
          </div>

          {/* Top 10 catalog targets for tonight */}
          <TonightTargets
            siteId={effectiveSiteId}
            timeZone={tz}
            isDark={isDark}
            observerLat={lat}
            observerLon={lon}
            darkWindowStart={
              forecast.tonight.astronomicalTwilightEnd ||
              forecast.tonight.nauticalTwilightEnd ||
              null
            }
            darkWindowEnd={
              forecast.tonight.astronomicalTwilightStart ||
              forecast.tonight.nauticalTwilightStart ||
              null
            }
          />
        </>
      )}
    </div>
  );
}
