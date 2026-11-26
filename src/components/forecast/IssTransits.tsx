/**
 * ISS transits of the Moon and the Sun near the site (GET /sky-events/iss-transits): when, for how long, and where to
 * stand. The band is a few kilometres wide and moves by kilometres with the age of the orbital elements, so each
 * transit says how far and which way the centre line is, draws it on a small map, and asks to check again shortly
 * before. A solar transit carries the solar-filter warning.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink, Moon, Sun } from 'lucide-react';
import { getIssTransits, type IssTransit } from '../../lib/api/iss';
import { formatDate } from '../../lib/formatLocale';
import { formatHm } from '../../lib/timeFormat';
import { compassKey } from '../../lib/compass';
import { scaleBarKm, toLocalKm } from '../../lib/transitMap';

const RADIUS_KEY = 'nebulis-iss-transit-radius';
const RADII = [25, 50, 100, 200] as const;

function readRadius(): number {
  try {
    const v = Number(localStorage.getItem(RADIUS_KEY));
    return (RADII as readonly number[]).includes(v) ? v : 50;
  } catch { return 50; }
}

function dayLabel(iso: string, timeZone?: string): string {
  try {
    return formatDate(new Date(iso), { weekday: 'short', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return formatDate(new Date(iso), { weekday: 'short', day: 'numeric', month: 'short' });
  }
}

/** "10:24:56.0": a transit lasts a second or two, so the tenths matter. Seconds are the same in every zone. */
function timeWithTenths(iso: string, timeZone?: string): string {
  const secs = (((Date.parse(iso) / 1000) % 60) + 60) % 60;
  return `${formatHm(new Date(iso), timeZone)}:${secs.toFixed(1).padStart(4, '0')}`;
}

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

export function IssTransits({ siteId, isDark, timeZone }: { siteId: string | null; isDark: boolean; timeZone?: string }) {
  const { t } = useTranslation('forecast');
  const [radiusKm, setRadiusKm] = useState(readRadius);
  const now = useNow(30_000);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['iss-transits', siteId, radiusKm],
    queryFn: () => getIssTransits({ siteId, radiusKm, days: 7 }),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const card = isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white';

  const countdown = (iso: string) => {
    const min = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
    if (min < 60) return t('issTransits.inMinutes', { count: min });
    const h = Math.floor(min / 60);
    return h < 48 ? t('issTransits.inHours', { count: h, minutes: min % 60 }) : t('issTransits.inDays', { count: Math.floor(h / 24) });
  };

  return (
    <section data-iss-transits>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className={`font-display text-lg font-semibold ${strong}`}>{t('issTransits.title')}</h2>
        <label className={`flex items-center gap-2 text-xs ${subtle}`}>
          {t('issTransits.radiusLabel')}
          <select
            value={radiusKm}
            onChange={e => {
              const v = Number(e.target.value);
              setRadiusKm(v);
              try { localStorage.setItem(RADIUS_KEY, String(v)); } catch { /* not remembered */ }
            }}
            className={`rounded-lg border px-2 py-1 text-xs ${isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-800'}`}
          >
            {RADII.map(r => <option key={r} value={r}>{t('issTransits.radius', { km: r })}</option>)}
          </select>
        </label>
      </div>
      <p className={`mb-3 text-xs ${subtle}`}>{t('issTransits.subtitle')}</p>

      {isLoading && <p className={`text-sm ${subtle}`}>{t('issTransits.loading')}</p>}
      {(isError || (data && !data.tle)) && <p className={`text-sm ${subtle}`}>{t('issPasses.unavailable')}</p>}
      {data?.tle && data.transits.length === 0 && <p className={`text-sm ${subtle}`}>{t('issTransits.none', { km: data.radiusKm })}</p>}

      {data && data.transits.length > 0 && data.site && (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.transits.map(tr => (
            <li key={`${tr.body}-${tr.time}`} className={`rounded-xl border p-3 text-sm ${card}`} data-iss-transit={tr.body}>
              <div className="flex gap-3">
                <TransitMap transit={tr} site={{ lat: data.site.latitude, lon: data.site.longitude }} isDark={isDark} />
                <div className="min-w-0 flex-1">
                  <div className={`flex items-center gap-1.5 font-medium ${strong}`}>
                    {tr.body === 'moon' ? <Moon className="h-4 w-4" aria-hidden="true" /> : <Sun className="h-4 w-4 text-amber-500" aria-hidden="true" />}
                    {t(`issTransits.body.${tr.body}`)}
                  </div>
                  <p className={`tabular-nums ${strong}`}>
                    {dayLabel(tr.time, timeZone)} · {timeWithTenths(tr.time, timeZone)}
                  </p>
                  <p className={`text-xs ${subtle}`}>
                    {t('issTransits.durationAlt', { duration: tr.durationSec.toFixed(1), alt: Math.round(tr.bodyAltitude) })} · {countdown(tr.time)}
                  </p>
                  <p className="mt-1 text-xs">
                    {tr.siteInBand
                      ? <span className={isDark ? 'text-emerald-300' : 'text-emerald-700'}>{t('issTransits.inBand', { width: (2 * tr.bandHalfWidthKm).toFixed(1) })}</span>
                      : t('issTransits.drive', {
                        distance: tr.nearest.distanceKm.toFixed(1),
                        dir: t(`issPasses.compass.${compassKey(tr.nearest.bearingDeg)}`),
                        width: (2 * tr.bandHalfWidthKm).toFixed(1),
                      })}
                  </p>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${tr.nearest.lat}&mlon=${tr.nearest.lon}#map=12/${tr.nearest.lat}/${tr.nearest.lon}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-accent-500 hover:underline"
                  >
                    {t('issTransits.openMap')}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                  {tr.body === 'sun' && (
                    <p className={`mt-1.5 flex items-start gap-1 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      {t('issTransits.solarSafety')}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data?.tle && (
        <p className={`mt-2 text-[0.6875rem] ${data.tle.stale ? (isDark ? 'text-amber-300' : 'text-amber-700') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}>
          {t('issTransits.recompute', { hours: Math.round(data.tle.ageHours) })}
        </p>
      )}
    </section>
  );
}

/** The centre line and its band around the site, north up, with a scale bar. */
function TransitMap({ transit, site, isDark }: { transit: IssTransit; site: { lat: number; lon: number }; isDark: boolean }) {
  const { t } = useTranslation('forecast');
  const size = 112;
  const points = transit.centerline.map(p => toLocalKm(site, p));
  const nearest = toLocalKm(site, transit.nearest);
  // Show the site and the nearest point with room around them, at least twice the band.
  const extent = Math.max(Math.abs(nearest.x), Math.abs(nearest.y), transit.bandHalfWidthKm * 2, 5) * 1.6;
  const s = size / (2 * extent);
  const px = (p: { x: number; y: number }) => `${(size / 2 + p.x * s).toFixed(1)},${(size / 2 - p.y * s).toFixed(1)}`;
  const bar = scaleBarKm(2 * extent);
  const line = points.map(px).join(' ');
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t('issTransits.mapLabel')}
      className={`shrink-0 rounded-lg ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}
      data-transit-map
    >
      <polyline points={line} fill="none" stroke={transit.body === 'sun' ? '#f59e0b' : '#a5b4fc'} strokeOpacity={0.3}
        strokeWidth={Math.max(2, 2 * transit.bandHalfWidthKm * s)} strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={line} fill="none" stroke={transit.body === 'sun' ? '#f59e0b' : '#a5b4fc'} strokeWidth={1.2} />
      <circle cx={size / 2} cy={size / 2} r={3} fill={isDark ? '#f8fafc' : '#0f172a'} />
      <circle cx={size / 2 + nearest.x * s} cy={size / 2 - nearest.y * s} r={2.5} fill="#10b981" />
      <text x={size - 8} y={12} fontSize={9} textAnchor="middle" fill={isDark ? '#94a3b8' : '#64748b'}>N</text>
      <line x1={8} y1={size - 8} x2={8 + bar * s} y2={size - 8} stroke={isDark ? '#94a3b8' : '#64748b'} strokeWidth={1.5} />
      <text x={8} y={size - 12} fontSize={8} fill={isDark ? '#94a3b8' : '#64748b'}>{t('issTransits.radius', { km: bar })}</text>
    </svg>
  );
}
