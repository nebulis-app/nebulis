import { useState } from 'react';
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
  ExternalLink,
  Info,
  ChevronDown,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { getCardClass } from './SettingsUI';

interface DataSource {
  name: string;
  description: string;
  url?: string;
  icon: ReactNode;
  badge: 'free' | 'bundled';
  cache?: string;
}

const DATA_SOURCE_GROUPS: Array<{
  title: string;
  sources: DataSource[];
}> = [
  {
    title: 'Astronomy Databases',
    sources: [
      { name: 'OpenNGC Catalog', description: '3,200+ deep sky objects with coordinates, magnitudes, and types', url: 'https://github.com/mattiaverga/OpenNGC', icon: <BookOpen className="w-4 h-4" />, badge: 'bundled', cache: 'Bundled with app' },
      { name: 'CDS Sesame', description: 'Resolves object names to RA/Dec via SIMBAD, NED, and VizieR', url: 'https://cdsweb.u-strasbg.fr', icon: <Globe className="w-4 h-4" />, badge: 'free', cache: 'Cached to disk' },
      { name: 'SIMBAD', description: 'Object properties including size and distance', url: 'https://simbad.cds.unistra.fr', icon: <Database className="w-4 h-4" />, badge: 'free' },
    ],
  },
  {
    title: 'Sky Images',
    sources: [
      { name: 'NASA Hubble Caldwell Catalog', description: 'Hubble Space Telescope imagery and descriptions for 88 Caldwell objects. NASA content is public domain.', url: 'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-caldwell-catalog/', icon: <Image className="w-4 h-4" />, badge: 'free', cache: 'Cached to disk' },
      { name: 'CDS HiPS Sky Survey', description: 'DSS2 color survey images for any RA/Dec coordinate', url: 'https://alasky.cds.unistra.fr', icon: <Image className="w-4 h-4" />, badge: 'free', cache: 'Cached to disk' },
      { name: 'NASA Image Library', description: 'Fallback images for solar system objects', url: 'https://images.nasa.gov', icon: <Image className="w-4 h-4" />, badge: 'free', cache: 'Cached to disk' },
      { name: 'Wikipedia', description: 'Object descriptions, summaries, and thumbnails', url: 'https://en.wikipedia.org', icon: <FileText className="w-4 h-4" />, badge: 'free' },
    ],
  },
  {
    title: 'Weather & Forecasting',
    sources: [
      { name: 'Open-Meteo', description: 'Temperature, humidity, cloud cover, wind, and precipitation', url: 'https://open-meteo.com', icon: <Cloud className="w-4 h-4" />, badge: 'free' },
      { name: '7Timer', description: 'Astronomical seeing and transparency forecasts', url: 'https://www.7timer.info', icon: <Cloud className="w-4 h-4" />, badge: 'free' },
      { name: 'SunCalc', description: 'Moon phase, twilight times, and sun/moon positions', icon: <Moon className="w-4 h-4" />, badge: 'bundled' },
    ],
  },
  {
    title: 'Satellite Tracking',
    sources: [
      { name: 'CelesTrak', description: 'TLE orbital elements for 14 satellite groups', url: 'https://celestrak.org', icon: <Satellite className="w-4 h-4" />, badge: 'free', cache: 'Cached 24 hours' },
    ],
  },
  {
    title: 'Maps',
    sources: [
      { name: 'CartoDB / OpenStreetMap', description: 'Map tiles for the observation location viewer', url: 'https://carto.com', icon: <Map className="w-4 h-4" />, badge: 'free' },
    ],
  },
];

export function DataSourcesSection({ isDark }: { isDark: boolean }) {
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
    free: 'Free API',
    bundled: 'Bundled',
  };

  const totalSources = DATA_SOURCE_GROUPS.reduce((sum, g) => sum + g.sources.length, 0);

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 mb-5">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-violet-500/10' : 'bg-violet-50'}`}>
          <Database className="w-5 h-5 text-violet-500" />
        </div>
        <div>
          <h2 className={`font-display text-[17px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Data Sources
          </h2>
          <p className={`text-[13px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {totalSources} services - all free, no API keys required
          </p>
        </div>
      </div>

      {/* Collapsible card */}
      <div className={getCardClass(isDark)}>
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center justify-between"
        >
          <span className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {expanded ? 'Hide' : 'Show'} all data sources
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
              <div key={group.title}>
                <h3
                  className={`text-[11px] font-semibold uppercase tracking-wider mb-2 ${
                    isDark ? 'text-slate-500' : 'text-slate-400'
                  }`}
                >
                  {group.title}
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
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              badgeStyles[source.badge]
                            }`}
                          >
                            {badgeLabels[source.badge]}
                          </span>
                          {source.cache && (
                            <span className={`text-[10px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                              {source.cache}
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                          {source.description}
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
                          title={`Visit ${source.name}`}
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
                All external services are free and require no API keys. Data is fetched on-demand and cached where
                possible. No personal data is sent to any external service.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

