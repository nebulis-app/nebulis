/**
 * What the object is, and the catalog's numbers for it.
 *
 * Previously a description column with a 36px-wide rail of seven 10px
 * label/value pairs bolted to its side, which is where a magnitude, a distance
 * and a pair of coordinates all ended up smaller than any other text on the
 * page. The description reads as prose and the numbers get a proper grid under
 * a rule, at the same scale as every other fact on the page.
 */
import { ExternalLink, Info } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { formatDec, formatDistanceLy, formatRa } from '../../lib/observationDisplay';
import { Fact, FactGrid, PanelEmpty, SessionPanel } from '../ui/Panel';

interface ObjectInfoLike {
  type?: string | null;
  constellation?: string | null;
  size?: string | null;
  ra?: string | null;
  dec?: string | null;
  description?: string | null;
  wikiUrl?: string | null;
}

export function ObjectPanel({ displayName, info, magnitude, distanceLy, alsoKnownAs }: {
  displayName: string;
  info: ObjectInfoLike | undefined;
  magnitude: number | null | undefined;
  distanceLy: number | null | undefined;
  /** Other catalog names for the same object. Optional: an observation is about
   *  one night and does not need them, while the object page does. */
  alsoKnownAs?: string[];
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const facts: { label: string; value: string; hint?: string }[] = [];
  if (info?.type) facts.push({ label: 'Type', value: info.type });
  if (info?.constellation) facts.push({ label: 'Constellation', value: info.constellation });
  if (magnitude != null) facts.push({ label: 'Magnitude', value: magnitude.toFixed(2) });
  if (distanceLy != null) facts.push({ label: 'Distance', value: formatDistanceLy(distanceLy) });
  if (info?.size) {
    facts.push({
      label: 'Angular size',
      value: info.size,
      hint: 'Apparent angular size as seen from Earth, measured in arcminutes (′). The full Moon is about 30′ across for comparison.',
    });
  }
  if (info?.ra) facts.push({ label: 'RA', value: formatRa(String(info.ra)) });
  if (info?.dec) facts.push({ label: 'Dec', value: formatDec(String(info.dec)) });

  const hasDescription = !!info?.description;

  return (
    <SessionPanel title={`About ${displayName}`} icon={Info}>
      {hasDescription && (
        <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {info!.description}
        </p>
      )}

      {!hasDescription && facts.length === 0 && (
        <PanelEmpty>No catalog entry for this object yet.</PanelEmpty>
      )}

      {facts.length > 0 && (
        <FactGrid className={hasDescription ? `mt-4 border-t pt-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}` : ''}>
          {facts.map(f => (
            <Fact key={f.label} label={f.label} value={f.value} hint={f.hint} />
          ))}
        </FactGrid>
      )}

      {alsoKnownAs && alsoKnownAs.length > 0 && (
        <div className={`mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t pt-4 ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}>
          <span className={`text-[10.5px] font-medium uppercase tracking-[0.12em] ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`}>
            Also known as
          </span>
          {alsoKnownAs.map(aka => (
            <span
              key={aka}
              className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
                isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {aka}
            </span>
          ))}
        </div>
      )}

      {info?.wikiUrl && (
        <a
          href={info.wikiUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium transition hover:underline ${accentText}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Read more on Wikipedia
        </a>
      )}
    </SessionPanel>
  );
}
