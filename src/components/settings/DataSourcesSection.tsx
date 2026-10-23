import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Database,
  BookOpen,
  Globe,
  Image,
  FileText,
  Cloud,
  Moon,
  Satellite,
  Map,
  Sparkles,
  ExternalLink,
  Info,
  ChevronDown,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Sec } from './SettingsUI';

interface DataSource {
  // Service/product names (OpenNGC, SIMBAD, Open-Meteo...) are proper nouns
  // and stay literal — only descriptionKey/cacheKey are translated.
  name: string;
  descriptionKey: string;
  url?: string;
  icon: ReactNode;
  badge: 'free' | 'bundled';
  cacheKey?: string;
}

// titleKey/descriptionKey/cacheKey rather than literal text: this array is
// built at module load, before any component's useTranslation() hook exists.
const DATA_SOURCE_GROUPS: Array<{
  titleKey: string;
  sources: DataSource[];
}> = [
  {
    titleKey: 'dataSources.groups.astronomyDatabases',
    sources: [
      { name: 'OpenNGC Catalog', descriptionKey: 'dataSources.descriptions.openngc', url: 'https://github.com/mattiaverga/OpenNGC', icon: <BookOpen className="w-4 h-4" />, badge: 'bundled', cacheKey: 'dataSources.cache.bundledWithApp' },
      { name: 'CDS Sesame', descriptionKey: 'dataSources.descriptions.sesame', url: 'https://cdsweb.u-strasbg.fr', icon: <Globe className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cachedToDisk' },
      { name: 'SIMBAD', descriptionKey: 'dataSources.descriptions.simbad', url: 'https://simbad.cds.unistra.fr', icon: <Database className="w-4 h-4" />, badge: 'free' },
    ],
  },
  {
    titleKey: 'dataSources.groups.skyImages',
    sources: [
      { name: 'NASA Hubble Caldwell Catalog', descriptionKey: 'dataSources.descriptions.hubbleCaldwell', url: 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-caldwell-catalog/', icon: <Image className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cachedToDisk' },
      { name: 'CDS HiPS Sky Survey', descriptionKey: 'dataSources.descriptions.hips', url: 'https://alasky.cds.unistra.fr', icon: <Image className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cachedToDisk' },
      { name: 'NASA Image Library', descriptionKey: 'dataSources.descriptions.nasaImageLibrary', url: 'https://images.nasa.gov', icon: <Image className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cachedToDisk' },
      { name: 'Wikipedia', descriptionKey: 'dataSources.descriptions.wikipedia', url: 'https://en.wikipedia.org', icon: <FileText className="w-4 h-4" />, badge: 'free' },
    ],
  },
  {
    titleKey: 'dataSources.groups.weatherForecasting',
    sources: [
      { name: 'Open-Meteo', descriptionKey: 'dataSources.descriptions.openMeteo', url: 'https://open-meteo.com', icon: <Cloud className="w-4 h-4" />, badge: 'free' },
      { name: '7Timer', descriptionKey: 'dataSources.descriptions.sevenTimer', url: 'https://www.7timer.info', icon: <Cloud className="w-4 h-4" />, badge: 'free' },
      { name: 'SunCalc', descriptionKey: 'dataSources.descriptions.sunCalc', icon: <Moon className="w-4 h-4" />, badge: 'bundled' },
    ],
  },
  {
    titleKey: 'dataSources.groups.satelliteTracking',
    sources: [
      { name: 'CelesTrak', descriptionKey: 'dataSources.descriptions.celestrak', url: 'https://celestrak.org', icon: <Satellite className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cached24h' },
    ],
  },
  {
    titleKey: 'dataSources.groups.maps',
    sources: [
      { name: 'Esri', descriptionKey: 'dataSources.descriptions.esri', url: 'https://www.esri.com', icon: <Map className="w-4 h-4" />, badge: 'free' },
    ],
  },
  {
    // The one entry here that receives the observer's own coordinates. Listed
    // separately from the weather services because it answers a different
    // question, and because it is the newest thing leaving the machine.
    titleKey: 'dataSources.groups.lightPollution',
    sources: [
      { name: 'DarkSkySites', descriptionKey: 'dataSources.descriptions.darkskysites', url: 'https://darkskysites.com', icon: <Sparkles className="w-4 h-4" />, badge: 'free', cacheKey: 'dataSources.cache.cached24h' },
    ],
  },
];

export function DataSourcesSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState(false);

  const badgeStyles: Record<string, string> = {
    free: isDark
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200',
    bundled: isDark
      ? 'bg-slate-700/50 text-slate-400 border-slate-600'
      : 'bg-slate-100 text-slate-600 border-slate-200',
  };

  const badgeLabels: Record<string, string> = {
    free: t('dataSources.freeApi'),
    bundled: t('dataSources.bundled'),
  };

  const totalSources = DATA_SOURCE_GROUPS.reduce((sum, g) => sum + g.sources.length, 0);

  return (
    <Sec
      title={t('dataSources.title')}
      description={t('dataSources.description', { count: totalSources })}
      isDark={isDark}
    >
      <div className="p-4 sm:p-5">
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center justify-between"
        >
          <span className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {expanded ? t('dataSources.hideAll') : t('dataSources.showAll')}
          </span>
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-200 ${isDark ? 'text-slate-500' : 'text-slate-400'} ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </button>

        {expanded && (
          <div className={`space-y-6 pt-5 mt-5 border-t ${isDark ? 'border-slate-800/50' : 'border-slate-100'}`}>
            {DATA_SOURCE_GROUPS.map(group => (
              <div key={group.titleKey}>
                <h3
                  className={`text-[0.625rem] font-semibold uppercase tracking-[0.1em] mb-2 ${
                    isDark ? 'text-slate-500' : 'text-slate-400'
                  }`}
                >
                  {t(group.titleKey)}
                </h3>
                <div className="space-y-1.5">
                  {group.sources.map(source => (
                    <div
                      key={source.name}
                      className={`flex items-start gap-3 p-3 rounded-xl ${
                        isDark ? 'bg-slate-800/30' : 'bg-slate-50/80'
                      }`}
                    >
                      <div className={`mt-0.5 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {source.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                            {source.name}
                          </span>
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium border ${
                              badgeStyles[source.badge]
                            }`}
                          >
                            {badgeLabels[source.badge]}
                          </span>
                          {source.cacheKey && (
                            <span className={`text-[0.625rem] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                              {t(source.cacheKey)}
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                          {t(source.descriptionKey)}
                        </p>
                      </div>
                      {source.url && (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`shrink-0 mt-0.5 transition-colors ${
                            isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-300 hover:text-slate-500'
                          }`}
                          title={t('dataSources.visitSource', { name: source.name })}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div
              className={`flex items-start gap-2 p-3 rounded-xl text-xs ${
                isDark ? 'bg-slate-800/20 text-slate-500' : 'bg-slate-50 text-slate-400'
              }`}
            >
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {t('dataSources.footerNote')}
              </span>
            </div>
          </div>
        )}
      </div>
    </Sec>
  );
}

