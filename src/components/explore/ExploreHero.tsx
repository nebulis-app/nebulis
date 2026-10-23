import { Compass, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CollapsibleHero } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { ObservingSite } from '../../lib/api/sites';

interface Props {
  accent: string;
  sites: ObservingSite[];
  site: ObservingSite | null;
  locationSet: boolean;
  onSite: (id: string) => void;
  /** The search box, rendered by the page so it can own its handlers. */
  children: React.ReactNode;
}

/**
 * Banner for Explore. The picture sits in its own clipped layer rather than on
 * the section, because the search dropdown has to hang below the banner and a
 * clipped section would cut it off.
 */
export function ExploreHero({ accent, sites, site, locationSet, onSite, children }: Props) {
  const { t } = useTranslation('catalogs');

  const siteControl = (
    locationSet && site ? (
            <label className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/35 px-3 py-1.5 text-xs text-white/80 backdrop-blur">
              <MapPin className="h-3.5 w-3.5" style={{ color: accent }} aria-hidden />
              <span className="sr-only">{t('explore.hero.site')}</span>
              {sites.length > 1 ? (
                <select
                  value={site.id}
                  onChange={e => onSite(e.target.value)}
                  className="max-w-[12rem] cursor-pointer truncate bg-transparent text-xs text-white outline-none"
                >
                  {sites.map(s => <option key={s.id} value={s.id} className="text-slate-900">{s.name}</option>)}
                </select>
              ) : (
                <span>{site.name}</span>
              )}
              {site.latitude != null && (
                <span className="text-white/50">{Math.abs(site.latitude).toFixed(1)}°{site.latitude >= 0 ? 'N' : 'S'}</span>
              )}
            </label>
          ) : (
            <Link
              to="/settings"
              className="flex items-center gap-1.5 rounded-full border border-accent-400/50 bg-accent-500/15 px-3 py-1.5 text-xs font-medium text-accent-200 backdrop-blur hover:bg-accent-500/25"
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              {t('explore.hero.setLocation')}
            </Link>
          )
  );

  return (
    <CollapsibleHero
      page="explore"
      image={PAGE_HERO.explore}
      accent={accent}
      bottomBloom={false}
      className="z-20"
      icon={<Compass className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('explore.hero.title')}
      collapsedBody={children}
      actions={siteControl}
      contentClassName="flex hero-min-h flex-col justify-center gap-5 p-4 sm:p-6"
    >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
              <Compass className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
              {t('explore.hero.title')}
            </h1>
            <p className="mt-2 hidden text-[0.8125rem] text-white/55 sm:block">{t('explore.hero.subtitle')}</p>
          </div>

          {siteControl}
        </div>

        {children}
    </CollapsibleHero>
  );
}
