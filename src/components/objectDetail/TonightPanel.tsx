/**
 * Whether you can shoot this target tonight, and when in the year it is worth
 * shooting at all.
 *
 * This is the question the object page never answered. Everything it showed was
 * a record of the past: nights already captured and catalog numbers. The one
 * thing you come to an imaged target for, "can I add to this tonight?", meant
 * leaving for the Planner and searching for the object again. The Catalogs
 * modal already answers it for objects you have never shot; this brings the
 * same answer to the ones you have.
 *
 * Everything here is computed in the browser from the object's coordinates and
 * the active observing site, with no server round-trip.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, MapPin, Telescope } from 'lucide-react';
import { AltitudeChart } from '../AltitudeChart';
import { SitePicker } from '../SitePicker';
import { Fact, FactGrid, PanelEmpty, SessionPanel } from '../ui/Panel';
import { computeAltitudeCurve } from '../../lib/altaz';
import { computeBestImagingWindow } from '../../lib/bestImagingWindow';
import { nightWindowFor, plannerToday } from '../../lib/nightWindow';
import { useTheme } from '../../hooks/useTheme';
import { getSites, type ObservingSite } from '../../lib/api/sites';
import { formatHm } from '../../lib/timeFormat';

interface Props {
  /** Decimal hours. Null when the catalog has no coordinates for this object. */
  raHours: number | null;
  /** Decimal degrees. */
  decDegrees: number | null;
  site: ObservingSite | null | undefined;
}

function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function TonightPanel({ raHours, decDegrees, site: activeSite }: Props) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  // Previewing a different site here is local to this panel and never
  // touches the app-wide active site (Planner/Forecast) — you're asking "how
  // would this look from my dark-sky site tonight", not relocating yourself.
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: getSites });
  const [previewSiteId, setPreviewSiteId] = useState<string | null>(null);
  // ObjectDetail doesn't remount this panel when navigating between objects
  // (same route, just a changed :objectId param), so without this a preview
  // picked on one object would silently leak into the next. Render-phase reset
  // (not an effect) so the stale preview never renders for a frame.
  const [coordSeed, setCoordSeed] = useState(`${raHours},${decDegrees}`);
  if (coordSeed !== `${raHours},${decDegrees}`) {
    setCoordSeed(`${raHours},${decDegrees}`);
    setPreviewSiteId(null);
  }
  const site = (previewSiteId && sites.find(s => s.id === previewSiteId)) || activeSite;

  const lat = site?.latitude ?? null;
  const lon = site?.longitude ?? null;
  const minAlt = site?.minAlt ?? 20;
  const hasEverything = raHours != null && decDegrees != null && lat != null && lon != null;

  /**
   * Tonight, sampled across astronomical darkness only. Sampling the whole
   * noon-to-noon window instead would report a peak that happens in daylight,
   * which is true and useless.
   */
  const tonight = useMemo(() => {
    if (!hasEverything) return null;
    const night = nightWindowFor(plannerToday(), lat, lon);
    if (!night) return { night: null, peakAlt: null, peakAt: null, minutesAbove: 0 };

    const samples = computeAltitudeCurve(raHours, decDegrees, lat, lon, night.start, night.end, 5);
    let peakAlt = -90;
    let peakAt: Date | null = null;
    let above = 0;
    for (const s of samples) {
      if (s.alt > peakAlt) { peakAlt = s.alt; peakAt = s.time; }
      if (s.alt >= minAlt) above += 5;
    }
    return { night, peakAlt, peakAt, minutesAbove: above };
  }, [hasEverything, raHours, decDegrees, lat, lon, minAlt]);

  const season = useMemo(() => {
    if (!hasEverything) return null;
    return computeBestImagingWindow(raHours, decDegrees, lat, lon, minAlt);
  }, [hasEverything, raHours, decDegrees, lat, lon, minAlt]);

  if (raHours == null || decDegrees == null) {
    return (
      <SessionPanel title="Tonight" icon={Telescope}>
        <PanelEmpty>
          No coordinates for this object, so its position cannot be worked out.
        </PanelEmpty>
      </SessionPanel>
    );
  }

  if (lat == null || lon == null) {
    return (
      <SessionPanel title="Tonight" icon={Telescope}>
        <PanelEmpty>
          <span className="inline-flex flex-wrap items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            Set an observing site in
            <Link to="/settings?tab=sky" className="font-medium underline underline-offset-2">Settings</Link>
            to see when this is up.
          </span>
        </PanelEmpty>
      </SessionPanel>
    );
  }

  const peakAlt = tonight?.peakAlt ?? null;
  const peakAt = tonight?.peakAt ?? null;
  const noDarkness = tonight?.night === null;
  // Above the horizon at all is a different question from above the altitude
  // you would actually image at, and both are worth saying.
  const up = peakAlt != null && peakAlt > 0;
  const worthIt = tonight != null && tonight.minutesAbove > 0;

  return (
    <SessionPanel
      title="Tonight"
      icon={Telescope}
      aside={
        sites.length > 1 ? (
          <SitePicker
            isDark={isDark}
            accentText={accentText}
            sites={sites}
            currentSite={site ?? null}
            fallbackLabel={site?.name ?? 'Choose a site'}
            onSelect={id => setPreviewSiteId(id)}
          />
        ) : (
          <span className={`truncate text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {site?.name}
          </span>
        )
      }
    >
      <div className={`flex items-start gap-2 text-[13px] ${
        worthIt
          ? (isDark ? 'text-slate-200' : 'text-slate-800')
          : (isDark ? 'text-slate-400' : 'text-slate-500')
      }`}>
        {worthIt
          ? <Eye className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          : <EyeOff className={`mt-0.5 h-4 w-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
        <p>
          {noDarkness ? (
            'No astronomical darkness tonight at this site.'
          ) : worthIt && peakAt ? (
            <>
              Climbs to <span className="font-semibold tabular-nums">{Math.round(peakAlt!)}°</span> around{' '}
              {/* site's timezone, not the viewer's — a plan made for a remote site is read in that site's night */}
              <span className="font-semibold tabular-nums">{formatHm(peakAt, site?.timezone)}</span>.
            </>
          ) : up ? (
            <>Rises tonight, but stays under your {minAlt}° minimum, so it is not worth setting up for.</>
          ) : (
            <>Below the horizon all night from here.</>
          )}
        </p>
      </div>

      {!noDarkness && (
        <div className="mt-4">
          <AltitudeChart
            ra={raHours}
            dec={decDegrees}
            lat={lat}
            lon={lon}
            minAlt={minAlt}
            timeZone={site?.timezone}
            isDark={isDark}
          />
        </div>
      )}

      <FactGrid className={`mt-4 border-t pt-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <Fact
          label={`Above ${minAlt}°`}
          value={worthIt ? formatHoursMinutes(tonight!.minutesAbove) : 'None tonight'}
          hint={`How long the object stays over your minimum altitude during tonight's astronomical darkness, at ${site?.name ?? 'this site'}.`}
        />
        <Fact
          label="Best months"
          value={season?.windowStart
            ? (season.windowStart === season.windowEnd
                ? season.windowStart
                : `${season.windowStart} to ${season.windowEnd}`)
            : season && !season.everVisible ? 'Never well placed' : 'Unknown'}
          hint="The run of months where this object clears your minimum altitude during darkness."
        />
      </FactGrid>
    </SessionPanel>
  );
}
