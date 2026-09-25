/**
 * Tonight's sky overview card for the Home dashboard.
 *
 * Layout (matches the "What's Up Tonight" design):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ ✦  What's Up Tonight                                    │
 *   │    Sky conditions for your location                     │
 *   │ ┌─────────────────────────────────────────────────────┐ │
 *   │ │ ⏱ DARKNESS                                          │ │
 *   │ │   7.8h                                              │ │
 *   │ │   22:03 – 05:49                                     │ │
 *   │ ├─────────────────────────────────────────────────────┤ │
 *   │ │ ◑ MOON                                              │ │
 *   │ │   [disk]  57%  First Quarter                        │ │
 *   │ │           Tonight: 61% · Waxing Gibbous             │ │
 *   │ ├─────────────────────────────────────────────────────┤ │
 *   │ │ ★ LIGHT POLLUTION                                   │ │
 *   │ │   Bortle Class N  description                       │ │
 *   │ └─────────────────────────────────────────────────────┘ │
 *   │  🌅 17:10 tonight                      🌄 00:06 tomorrow │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Light Pollution tile — automatic Bortle detection:
 *   1. On mount (or whenever the active site changes), if the site has
 *      coordinates but no saved Bortle class, the component automatically
 *      triggers a lookup via POST /sites/:id/bortle-lookup (DarkSkySites.com,
 *      proxied by the Nebulis server — no API key, monthly VIIRS satellite
 *      data).  The result is written back to the site record so it persists
 *      across sessions and appears in Settings → Sites.
 *   2. A manual "Refresh" button is always shown to admins so they can
 *      re-query at any time (e.g. after moving a site).
 *   3. If the site has no coordinates at all, a short hint is shown instead.
 */
import { useEffect, useRef, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import i18n from '../../i18n';
import { AlertCircle, Clock, Cloud, Locate, Moon, RotateCw, Sparkles, Star, Sunrise, Sunset } from 'lucide-react';
import { lookupSiteBortle, updateSite, type ObservingSite } from '../../lib/api/sites';
import { useAuth } from '../../contexts/AuthContext';
import {
  calculateVisibilityScore,
  formatTime,
  scoreHex,
  scoreLabel,
  type DarkWindow,
} from '../../lib/forecastScore';
import type { ForecastHour } from '../../lib/api/planner';
import { MoonDisk } from '../ui/MoonDisk';

// ─── Bortle labels ────────────────────────────────────────────────────────
const BORTLE_LABELS: Record<number, { label: string; description: string; color: string }> = {
  1: { label: 'Bortle 1', description: 'Zodiacal light, gegenschein visible', color: 'text-emerald-400' },
  2: { label: 'Bortle 2', description: 'Truly dark skies',                    color: 'text-emerald-500' },
  3: { label: 'Bortle 3', description: 'Rural sky',                            color: 'text-emerald-600' },
  4: { label: 'Bortle 4', description: 'Rural / suburban transition',           color: 'text-blue-400'    },
  5: { label: 'Bortle 5', description: 'Suburban sky',                          color: 'text-blue-500'    },
  6: { label: 'Bortle 6', description: 'Bright suburban sky',                   color: 'text-amber-400'   },
  7: { label: 'Bortle 7', description: 'Suburban / urban transition',            color: 'text-amber-500'   },
  8: { label: 'Bortle 8', description: 'City sky',                               color: 'text-orange-500'  },
  9: { label: 'Bortle 9', description: 'Inner-city sky',                         color: 'text-red-500'     },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Format decimal hours as "7.8h" (one decimal, no trailing zero). */
function formatDarkHoursShort(hours: number): string {
  if (!hours || hours <= 0) return '0h';
  return `${Math.round(hours * 10) / 10}h`;
}

// ─── Inner tile ───────────────────────────────────────────────────────────
/** A section inside the inner card, separated from the next by a divider. */
function InnerTile({
  icon,
  label,
  children,
  isDark,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div className={`px-4 py-4 border-b last:border-b-0 ${isDark ? 'border-slate-700/60' : 'border-slate-200'}`}>
      {/* Row label */}
      <div className={`flex items-center gap-1.5 mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        <span className="shrink-0">{icon}</span>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em]">{label}</span>
      </div>
      {children}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────

interface TonightInfo {
  moonIllumination: number;
  moonPhase: string;
  moonRise: string | null;
  moonSet: string | null;
  sunset: string;
  sunrise: string;
  darkHours: number;
  nauticalDarkHours: number;
  astronomicalTwilightEnd: string;
  astronomicalTwilightStart: string;
  nauticalTwilightEnd: string;
  nauticalTwilightStart: string;
}

interface Props {
  tonight: TonightInfo;
  /** Hourly data points covering the dark window — used to compute the
   *  overall night weather score shown in the Moon tile. */
  hours: ForecastHour[];
  darkWindow: DarkWindow | null;
  site: ObservingSite | null;
  timeZone?: string;
  isDark: boolean;
}

const t = (k: string, opts?: Record<string, unknown>) => i18n.t(k, { ns: 'forecast', ...opts });

// ─── Component ────────────────────────────────────────────────────────────
export function NightOverview({ tonight, hours, darkWindow, site, timeZone, isDark }: Props) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const fmt = (iso: string | null) => (iso ? formatTime(iso, timeZone) : '–');

  const bortle     = site?.bortleClass ?? null;
  const bortleInfo = bortle != null ? BORTLE_LABELS[bortle] : null;

  // Track which site id we've already auto-detected for, so a re-render
  // (e.g. after the site list query refetches) doesn't fire a second lookup.
  const autoDetectedForSiteId = useRef<string | null>(null);

  // Mutation: POST /sites/:id/bortle-lookup → write result back via PUT /sites/:id
  const detectMut = useMutation({
    mutationFn: async (siteId: string) => {
      const result = await lookupSiteBortle(siteId);
      await updateSite(siteId, { bortleClass: result.bortleClass });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      queryClient.invalidateQueries({ queryKey: ['active-site'] });
    },
  });

  const hasCoords  = site != null && site.latitude != null && site.longitude != null;
  const canDetect  = isAdmin && hasCoords;

  // ── Auto-detect on first load (or site change) when Bortle is not set ──
  // Fires for any authenticated user who is admin and has a site with
  // coordinates — no button click required. If the site already has a
  // Bortle class (saved from a prior detection or manual entry in Settings),
  // we skip the network call entirely.
  useEffect(() => {
    if (!isAdmin) return;
    if (!site) return;
    if (!hasCoords) return;
    if (site.bortleClass != null) return;                    // already set
    if (autoDetectedForSiteId.current === site.id) return;  // already attempted
    if (detectMut.isPending) return;

    autoDetectedForSiteId.current = site.id;
    detectMut.mutate(site.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, site?.bortleClass, isAdmin, hasCoords]);

  // ── Compute an overall night weather score from the window hours ──────
  // Average visibility score + average cloud cover across all dark-window
  // hourly data points.  Memoised — hours is already the filtered+smoothed
  // strip from the parent, so this is a cheap reduce.
  const nightWeather = useMemo(() => {
    if (hours.length === 0) return null;
    let totalScore = 0;
    let totalCloud = 0;
    for (const h of hours) {
      const vis = calculateVisibilityScore(h, tonight.moonIllumination, timeZone, darkWindow, t);
      totalScore += vis.score;
      totalCloud += h.cloudCover;
    }
    const avgScore = Math.round(totalScore / hours.length);
    const avgCloud = Math.round(totalCloud / hours.length);
    return { avgScore, avgCloud };
  }, [hours, tonight.moonIllumination, timeZone, darkWindow]);

  // Prefer astronomical twilight; fall back to nautical.
  const darkStart = tonight.astronomicalTwilightEnd || tonight.nauticalTwilightEnd;
  const darkEnd   = tonight.astronomicalTwilightStart || tonight.nauticalTwilightStart;
  const darkLabel = tonight.astronomicalTwilightEnd ? 'Darkness' : 'Nautical darkness';
  const darkHours = tonight.darkHours > 0 ? tonight.darkHours : tonight.nauticalDarkHours;

  // Outer card colours
  const outerBg     = isDark ? 'bg-[#0e1117] border-slate-700/50' : 'bg-slate-50 border-slate-200 shadow-sm';
  // Inner card (the rounded box containing the tiles)
  const innerBg     = isDark ? 'bg-slate-800/50 border-slate-700/40' : 'bg-white border-slate-200 shadow-sm';
  // Footer accent
  const footerColor = isDark ? 'text-amber-400' : 'text-amber-600';
  const footerSub   = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <section
      aria-label="What's up tonight"
      className={`rounded-2xl border overflow-hidden flex flex-col h-full ${outerBg}`}
    >
      {/* ── Outer header ────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-4 flex flex-col flex-1">
        <div className="flex items-center gap-3 mb-4">
          {/* Icon badge */}
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isDark ? 'bg-amber-500/15' : 'bg-amber-50'
          }`}>
            <Sparkles className={`h-4.5 w-4.5 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
          </div>
          <div>
            <h2 className={`font-display text-lg font-bold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              What's Up Tonight
            </h2>
            <p className={`text-[12px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Sky conditions for your location
              {site?.name ? ` · ${site.name}` : ''}
            </p>
          </div>
        </div>

        {/* ── Inner card ──────────────────────────────────────── */}
        <div className={`rounded-xl border overflow-hidden flex-1 ${innerBg}`}>

          {/* Tile 1 — Darkness */}
          <InnerTile
            icon={<Clock className="h-3.5 w-3.5" />}
            label={darkLabel}
            isDark={isDark}
          >
            {darkHours > 0 ? (
              <>
                <p className={`text-4xl font-bold tabular-nums leading-none ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  {formatDarkHoursShort(darkHours)}
                  <span className={`ml-1 text-xl font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>h</span>
                </p>
                {darkStart && darkEnd && (
                  <p className={`mt-1.5 text-sm tabular-nums ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {fmt(darkStart)} – {fmt(darkEnd)}
                  </p>
                )}
              </>
            ) : (
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                No astronomical darkness tonight
              </p>
            )}
          </InnerTile>

          {/* Tile 2 — Weather conditions (50%) + Moon (50%) */}
          {/* Replaces InnerTile so we can render two equal sub-tiles with a
              shared label row and a vertical divider between the two halves. */}
          <div className={`border-b ${isDark ? 'border-slate-700/60' : 'border-slate-200'}`}>
            <div className={`grid grid-cols-2 divide-x ${isDark ? 'divide-slate-700/60' : 'divide-slate-200'}`}>

              {/* ── Left sub-tile: Weather conditions ─────────── */}
              <div className="px-4 py-4">
                {/* Sub-tile label */}
                <div className={`flex items-center gap-1.5 mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Cloud className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em]">
                    Conditions
                  </span>
                </div>

                {nightWeather ? (() => {
                  const hex = scoreHex(nightWeather.avgScore);
                  return (
                    <div className="flex flex-col gap-2">
                      {/* Big score number */}
                      <p
                        className="text-4xl font-bold tabular-nums leading-none"
                        style={{ color: hex }}
                      >
                        {nightWeather.avgScore}
                        <span
                          className="ml-1.5 text-xl font-semibold"
                          style={{ color: `${hex}99` }}
                        >
                          {scoreLabel(nightWeather.avgScore, t)}
                        </span>
                      </p>
                      {/* Cloud cover */}
                      <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {nightWeather.avgCloud}% cloud cover
                      </p>
                    </div>
                  );
                })() : (
                  <p className={`text-sm ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>–</p>
                )}
              </div>

              {/* ── Right sub-tile: Moon ──────────────────────── */}
              <div className="px-4 py-4">
                {/* Sub-tile label */}
                <div className={`flex items-center gap-1.5 mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  <Moon className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em]">
                    Moon
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <MoonDisk
                    illumination={tonight.moonIllumination}
                    phase={tonight.moonPhase}
                    size={52}
                  />
                  <div>
                    <p className={`text-4xl font-bold tabular-nums leading-none ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                      {Math.round(tonight.moonIllumination)}
                      <span className={`text-xl font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>%</span>
                    </p>
                    <p className={`mt-1 text-sm font-medium capitalize ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                      {tonight.moonPhase}
                    </p>
                    {tonight.moonRise && (
                      <p className={`mt-0.5 text-[11px] tabular-nums ${
                        tonight.moonIllumination > 70
                          ? isDark ? 'text-amber-400' : 'text-amber-600'
                          : isDark ? 'text-slate-500' : 'text-slate-400'
                      }`}>
                        Rise: {fmt(tonight.moonRise)}
                        {tonight.moonSet ? ` · Set: ${fmt(tonight.moonSet)}` : ''}
                      </p>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* Tile 3 — Light pollution (Bortle) */}
          <InnerTile
            icon={<Star className="h-3.5 w-3.5" />}
            label="Light Pollution"
            isDark={isDark}
          >
            {bortleInfo ? (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={`text-2xl font-bold leading-none ${bortleInfo.color}`}>
                    {bortleInfo.label}
                  </p>
                  <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {bortleInfo.description}
                  </p>
                </div>
                {/* Allow re-detection even when already set */}
                {canDetect && (
                  <button
                    onClick={() => { autoDetectedForSiteId.current = null; detectMut.mutate(site!.id); }}
                    disabled={detectMut.isPending}
                    title="Re-detect Bortle class from satellite data"
                    className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10.5px] font-medium transition-all disabled:opacity-50 ${
                      isDark
                        ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/60'
                        : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {detectMut.isPending
                      ? <RotateCw className="h-3 w-3 animate-spin" />
                      : <Locate className="h-3 w-3" />
                    }
                    Refresh
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {/* While auto-detecting, show a subtle spinner instead of "not configured" */}
                {detectMut.isPending ? (
                  <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    <RotateCw className="h-4 w-4 animate-spin shrink-0" />
                    Detecting from location…
                  </div>
                ) : (
                  <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Not configured
                  </p>
                )}

                {/* Manual trigger — shown while auto-detect is in flight or after it errors */}
                {canDetect && !detectMut.isPending && (
                  <button
                    onClick={() => { autoDetectedForSiteId.current = null; detectMut.mutate(site!.id); }}
                    className={`self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isDark
                        ? 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    <Locate className="h-3.5 w-3.5" /> Detect from location
                  </button>
                )}

                {/* No coordinates → guide the user */}
                {isAdmin && site != null && (site.latitude == null || site.longitude == null) && (
                  <p className={`text-[11px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                    Add coordinates in Settings → Sites to enable auto-detection.
                  </p>
                )}

                {/* Error state */}
                {detectMut.isError && (
                  <div className={`flex items-center gap-1.5 text-[11px] text-red-500`}>
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {detectMut.error instanceof Error
                      ? detectMut.error.message
                      : 'Detection failed — try again.'}
                  </div>
                )}
              </div>
            )}
          </InnerTile>
        </div>
      </div>

      {/* ── Footer: sunset / sunrise ─────────────────────────── */}
      <div className={`flex items-center justify-between gap-4 px-5 pb-5`}>
        {/* Sunset */}
        <div className="flex items-center gap-2">
          <Sunset className={`h-4 w-4 shrink-0 ${footerColor}`} />
          <span className={`text-sm font-bold tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {fmt(tonight.sunset)}
          </span>
          <span className={`text-xs ${footerSub}`}>tonight</span>
        </div>

        {/* Sunrise */}
        <div className="flex items-center gap-2">
          <Sunrise className={`h-4 w-4 shrink-0 ${footerColor}`} />
          <span className={`text-sm font-bold tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {fmt(tonight.sunrise)}
          </span>
          <span className={`text-xs ${footerSub}`}>tomorrow</span>
        </div>
      </div>
    </section>
  );
}
