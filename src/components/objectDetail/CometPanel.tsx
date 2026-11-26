/**
 * Tonight for a comet in the library, in place of the fixed-coordinates panel other objects get: a comet has no
 * catalog position, so the answer comes from its ephemeris (JPL Horizons, through the planner's comet list, which
 * includes every library comet). Links to the planner and to JPL's page for the body.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Telescope } from 'lucide-react';
import { getPlannerComets } from '../../lib/api/planner';
import { cometStatusLine, jplLink } from '../../lib/cometStatus';

export function CometPanel({ libraryObjectId, timeZone }: { libraryObjectId: string; timeZone?: string }) {
  const { t } = useTranslation('planner');
  const { data } = useQuery({
    queryKey: ['planner-comets', null, 'today'],
    queryFn: () => getPlannerComets(),
    staleTime: 10 * 60_000,
  });
  const entry = data?.bodies.find(b => b.body.libraryObjectId === libraryObjectId);
  if (!data || !entry) return null;
  const line = data.enabled ? cometStatusLine(entry, t, timeZone) : t('comets.disabled');

  return (
    <div className="space-y-2 rounded-xl bg-black/35 p-3 text-xs text-white/80 ring-1 ring-inset ring-white/10 backdrop-blur-md" data-comet-panel>
      <div className="flex items-center gap-1.5 font-medium text-white">
        <Telescope className="h-3.5 w-3.5 text-accent-400" aria-hidden="true" />
        {t('comets.objectTitle')}
      </div>
      {line && <p>{line}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Link to="/planner" className="rounded-full bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20">
          {t('comets.openPlanner')}
        </Link>
        <a
          href={jplLink(entry.body.designation)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20"
        >
          {t('comets.ephemeris', { designation: entry.body.designation })}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
