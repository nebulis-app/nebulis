/**
 * Sky Forecast.
 *
 * Tonight gets the whole top of the page: one rating, the Moon at its real
 * phase, the key times, and a ribbon that draws the night end to end on a
 * single time axis. Picking an hour on the ribbon opens its breakdown. The
 * nights ahead sit below as a short outlook.
 *
 * All scoring lives in lib/forecastScore so the hero, the ribbon, and the hour
 * detail can never disagree about what a number means.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, RotateCw } from 'lucide-react';
import { getForecastForSite, type ForecastHour } from '../lib/api/planner';
import { getSettings } from '../lib/api/settings';
import { getSites, getActiveSite, setActiveSite, type ObservingSite } from '../lib/api/sites';
import { useTheme } from '../hooks/useTheme';
import { LocationPrompt } from '../components/LocationPrompt';
import { SitePicker } from '../components/SitePicker';
import { smoothHours, type DarkWindow } from '../lib/forecastScore';
import { TonightHero } from '../components/forecast/TonightHero';
import { HourDetail } from '../components/forecast/HourDetail';
import { NightOutlookCard } from '../components/forecast/NightOutlookCard';
import { RatingLegend } from '../components/ui/RatingLegend';
import { hoursForNight } from '../lib/forecastNights';

export function ForecastPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  // The hero sits on a night-sky panel in every theme, so it takes the bright
  // accent value directly rather than the light-mode-darkened token.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const queryClient = useQueryClient();
  const [selectedHour, setSelectedHour] = useState<ForecastHour | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // temperatureUnit/windSpeedUnit are genuine app-wide preferences, not
  // per-site, so these stay on the legacy settings fetch.
  const { data: appSettings } = useQuery({ queryKey: ['settings'], queryFn: getSettings, staleTime: Infinity });
  const tempUnit = appSettings?.temperatureUnit ?? 'fahrenheit';
  const windUnit = appSettings?.windSpeedUnit ?? 'mph';

  // Coordinates/timezone/name come from the observing site instead — see
  // PlannerPage for the same pattern and why it replaced the settings mirror.
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: getSites, staleTime: 0, refetchInterval: 60_000 });
  const activeSiteQuery = useQuery({ queryKey: ['active-site'], queryFn: getActiveSite, staleTime: 0 });
  const sites = sitesQuery.data ?? [];
  const [pickedSiteId, setPickedSiteId] = useState<string | null>(null);
  const effectiveSiteId = pickedSiteId ?? activeSiteQuery.data?.id ?? null;
  const currentSite: ObservingSite | null =
    sites.find(s => s.id === effectiveSiteId) ?? activeSiteQuery.data ?? null;

  const setActiveSiteMut = useMutation({
    mutationFn: (siteId: string) => setActiveSite(siteId),
    onSuccess: (site) => {
      setPickedSiteId(site.id);
      setSelectedHour(null);
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
    enabled: effectiveSiteId != null && lat !== null && lon !== null,
    staleTime: 600_000,
  });

  const tz = forecast?.timezone || currentSite?.timezone || undefined;

  // The precise dark window for moon-penalty calculations. Prefer astronomical
  // twilight, fall back to nautical. May be null at high latitudes in summer.
  // Memoised because it is a dependency of the ribbon's per-hour scoring.
  const darkWindow: DarkWindow | null = useMemo(() => {
    if (!forecast) return null;
    const windowStart = forecast.tonight.astronomicalTwilightEnd || forecast.tonight.nauticalTwilightEnd;
    const windowEnd = forecast.tonight.astronomicalTwilightStart || forecast.tonight.nauticalTwilightStart;
    if (!windowStart || !windowEnd) return null;
    return { start: new Date(windowStart).getTime(), end: new Date(windowEnd).getTime() };
  }, [forecast]);

  // The window used to filter the hourly strip. When there's no astronomical or
  // nautical dark (e.g. high-latitude summer), fall back to the full
  // sunset→sunrise span so the hourly forecast is always shown.
  const hourlyWindow: DarkWindow | null = useMemo(() => {
    if (!forecast) return null;
    if (darkWindow) return darkWindow;
    const s = forecast.tonight.sunset;
    const e = forecast.tonight.sunrise;
    if (!s || !e) return null;
    return { start: new Date(s).getTime(), end: new Date(e).getTime() };
  }, [forecast, darkWindow]);

  // Filter the hourly data to the usable night window with a 1-hour buffer.
  const tonightHours = useMemo(
    () => smoothHours((forecast?.hourly || []).filter(h => {
      if (!hourlyWindow) return false;
      const t = new Date(h.time).getTime();
      return t >= hourlyWindow.start - 3600000 && t <= hourlyWindow.end + 3600000;
    })),
    [forecast, hourlyWindow],
  );

  // The outlook is the nights strictly after the one the hero shows. Key that
  // off the hero's own sunset, NOT nightRatings[0].date: when a cached forecast
  // was built before the early-morning rollover the two disagree (the ratings
  // key off a calendar-day string that's still yesterday, while the sun times
  // have already rolled to today), and dropping only nightRatings[0] then
  // leaves tonight in the list, duplicated with the hero.
  const heroNightKey = useMemo(() => {
    if (!forecast) return '';
    const d = new Date(forecast.tonight.sunset);
    if (Number.isNaN(d.getTime())) return forecast.nightRatings[0]?.date ?? '';
    // tz comes from the site record or the forecast response; a corrupted or
    // stale value (a site saved before timezone validation, a renamed IANA
    // zone) throws here and previously took down the whole page with no
    // recovery. Every other Intl.DateTimeFormat call in this codebase
    // guards the same way (see src/lib/altaz.ts, src/lib/timeFormat.ts,
    // server/lib/timezone.ts) — this was the one that didn't.
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d);
    } catch {
      return forecast.nightRatings[0]?.date ?? '';
    }
  }, [forecast, tz]);
  const upcomingNights = forecast?.nightRatings.filter(n => !heroNightKey || n.date > heroNightKey) ?? [];

  const siteControl = locationSet && (
    <div className="flex items-center gap-2 shrink-0">
      <SitePicker
        isDark={isDark}
        accentText={accentText}
        sites={sites}
        currentSite={currentSite}
        fallbackLabel={lat != null && lon != null ? `${lat.toFixed(2)}, ${lon.toFixed(2)}` : ''}
        onSelect={(id) => setActiveSiteMut.mutate(id)}
        isSwitching={setActiveSiteMut.isPending}
      />
      <button
        onClick={async () => {
          if (!effectiveSiteId) return;
          setRefreshing(true);
          try {
            await queryClient.fetchQuery({
              queryKey: ['forecast', effectiveSiteId],
              queryFn: () => getForecastForSite(effectiveSiteId, true),
              staleTime: 0,
            });
          } catch { /* ignore */ }
          setRefreshing(false);
        }}
        disabled={refreshing || !effectiveSiteId}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/50 transition hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
        title="Refresh forecast"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  );

  return (
    <div className="space-y-8">
      {/* Location not set — same empty state as Planner; persists to the default
          site. Gated on the site queries having resolved so this doesn't flash
          before the sites list loads. */}
      {!locationSet && !sitesQuery.isLoading && !activeSiteQuery.isLoading && (
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
        <div className={`text-center py-12 rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
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
          {tonightHours.length > 1 ? (
            <TonightHero
              hours={tonightHours}
              tonight={forecast.tonight}
              timeZone={tz}
              darkWindow={darkWindow}
              tempUnit={tempUnit}
              selectedTime={selectedHour?.time ?? null}
              onSelect={(h) => setSelectedHour(prev => (prev?.time === h.time ? null : h))}
              accent={accent}
              siteControl={siteControl}
            />
          ) : (
            <div className={`rounded-2xl border p-6 text-sm ${
              isDark ? 'bg-slate-900 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'
            }`}>
              No hourly data available for tonight's observing window.
            </div>
          )}

          {selectedHour && (
            <HourDetail
              hour={selectedHour}
              moonIllumination={forecast.tonight.moonIllumination}
              isDark={isDark}
              onClose={() => setSelectedHour(null)}
              tempUnit={tempUnit}
              windUnit={windUnit}
              timeZone={tz}
              darkWindow={darkWindow}
            />
          )}

          {tonightHours.length > 1 && <RatingLegend isDark={isDark} />}

          {upcomingNights.length > 0 && (
            <div>
              <h2 className={`font-display text-lg font-semibold mb-4 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                The nights ahead
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {upcomingNights.map(night => (
                  <NightOutlookCard
                    key={night.date}
                    night={night}
                    hours={hoursForNight(forecast.hourly, night.date, tz)}
                    isDark={isDark}
                    windUnit={windUnit}
                    timeZone={tz}
                  />
                ))}
              </div>
            </div>
          )}

          <p className={`text-[11px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            Source: {[forecast.sources.weather, forecast.sources.seeing].filter(Boolean).join(', ')}
          </p>
        </>
      )}
    </div>
  );
}
