/**
 * Light pollution for the active observing site, as a tile in the Sky Forecast
 * hero's key-facts row.
 *
 * The Bortle class belongs to the place rather than to the night, so it comes
 * from the site record, not from the forecast. When a site has coordinates but
 * no class yet, the first admin to open this page gets it filled in from the
 * VIIRS satellite composite, and the tile carries a button to re-detect.
 *
 * That lookup is the only request Nebulis makes carrying the observer's exact
 * coordinates to a third party. The route enforces the admin check itself; this
 * checks first so a viewer never triggers it at all. Disclosed on the Help page
 * and in Settings -> Data Sources.
 */
import { useEffect, useRef } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lookupSiteBortle, updateSite, type ObservingSite } from '../../lib/api/sites';
import { useAuth } from '../../contexts/AuthContext';
import { StatPill } from './TonightHero';

/** Tone per Bortle class, dark skies through inner city. The descriptions are
 *  translated and live in forecast.json, so only the colour is here. */
const BORTLE_TONE: Record<number, string> = {
  1: 'text-emerald-300',
  2: 'text-emerald-400',
  3: 'text-emerald-500',
  4: 'text-blue-400',
  5: 'text-blue-500',
  6: 'text-amber-400',
  7: 'text-amber-500',
  8: 'text-orange-500',
  9: 'text-red-500',
};

export function LightPollutionPill({ site }: { site: ObservingSite | null }) {
  const { t } = useTranslation('forecast');
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const siteId = site?.id ?? null;
  const bortleClass = site?.bortleClass ?? null;
  const hasCoords = site != null && site.latitude != null && site.longitude != null;

  const detect = useMutation({
    mutationFn: async () => {
      // Every trigger is gated on a site being present; this narrows siteId.
      if (siteId === null) throw new Error('No observing site selected');
      const result = await lookupSiteBortle(siteId);
      // Written straight back to the site so Settings, the native clients and
      // every later page load see the same value without a second lookup.
      await updateSite(siteId, { bortleClass: result.bortleClass });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      queryClient.invalidateQueries({ queryKey: ['active-site'] });
    },
  });

  // Fill the class in automatically, once per site, for an admin whose site has
  // coordinates and nothing recorded yet. The server caches the answer for a
  // day, so this is at most one upstream request per site per day. The ref stops
  // a failure from retrying on every render: the button is the retry path.
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!isAdmin || siteId == null || !hasCoords || bortleClass != null) return;
    if (attempted.current === siteId) return;
    attempted.current = siteId;
    detect.mutate();
  }, [isAdmin, siteId, hasCoords, bortleClass, detect]);

  const value = bortleClass != null
    ? t('tonightHero.bortleClass', { number: bortleClass })
    : t('tonightHero.bortleNotSet');

  const sub = detect.isError
    ? t('tonightHero.bortleFailed')
    : bortleClass != null
      ? t(`tonightHero.bortle.${bortleClass}`)
      : !hasCoords
        ? t('tonightHero.bortleNeedsLocation')
        : detect.isPending
          ? t('tonightHero.bortleDetecting')
          : t('tonightHero.bortleWaiting');

  return (
    <StatPill
      icon={<Sparkles className="h-3.5 w-3.5" />}
      label={t('tonightHero.lightPollution')}
      value={value}
      sub={sub}
      valueClass={bortleClass != null ? BORTLE_TONE[bortleClass] : undefined}
      action={isAdmin && hasCoords ? (
        <button
          type="button"
          onClick={() => detect.mutate()}
          disabled={detect.isPending}
          title={t('tonightHero.detectLightPollution')}
          aria-label={t('tonightHero.detectLightPollution')}
          className="rounded-full p-0.5 text-white/40 transition hover:text-white/80 disabled:opacity-40
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <RefreshCw className={`h-3 w-3 ${detect.isPending ? 'animate-spin' : ''}`} />
        </button>
      ) : undefined}
    />
  );
}
