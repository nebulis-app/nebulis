/**
 * What the object is, and the catalog's numbers for it.
 *
 * Previously a description column with a 36px-wide rail of seven 10px
 * label/value pairs bolted to its side, which is where a magnitude, a distance
 * and a pair of coordinates all ended up smaller than any other text on the
 * page. The description reads as prose and the numbers get a proper grid under
 * a rule, at the same scale as every other fact on the page.
 */
import { useTranslation } from 'react-i18next';
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

export function ObjectPanel({ displayName, info, magnitude, distanceLy, alsoKnownAs, hideHeader = false }: {
  displayName: string;
  info: ObjectInfoLike | undefined;
  magnitude: number | null | undefined;
  distanceLy: number | null | undefined;
  /** Other catalog names for the same object. Optional: an observation is about
   *  one night and does not need them, while the object page does. */
  alsoKnownAs?: string[];
  /** Omit the "About X" heading when the caller already shows it. */
  hideHeader?: boolean;
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const { t } = useTranslation('observations');
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const facts: { label: string; value: string; hint?: string }[] = [];
  if (info?.type) facts.push({ label: t('observationDetail.objectPanel.type'), value: info.type });
  if (info?.constellation) facts.push({ label: t('observationDetail.objectPanel.constellation'), value: info.constellation });
  if (magnitude != null) facts.push({ label: t('observationDetail.objectPanel.magnitude'), value: magnitude.toFixed(2) });
  if (distanceLy != null) facts.push({ label: t('observationDetail.objectPanel.distance'), value: formatDistanceLy(distanceLy) });
  if (info?.size) {
    facts.push({
      label: t('observationDetail.objectPanel.angularSize'),
      value: info.size,
      hint: t('observationDetail.objectPanel.angularSizeHint'),
    });
  }
  if (info?.ra) facts.push({ label: t('observationDetail.objectPanel.ra'), value: formatRa(String(info.ra)) });
  if (info?.dec) facts.push({ label: t('observationDetail.objectPanel.dec'), value: formatDec(String(info.dec)) });

  const hasDescription = !!info?.description;

  return (
    <SessionPanel title={t('observationDetail.objectPanel.about', { name: displayName })} icon={Info} hideHeader={hideHeader}>
      {hasDescription && (
        <p className={`text-[0.8125rem] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {info?.description}
        </p>
      )}

      {!hasDescription && facts.length === 0 && (
        <PanelEmpty>{t('observationDetail.objectPanel.noCatalogEntry')}</PanelEmpty>
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
          <span className={`text-[0.6562rem] font-medium uppercase tracking-[0.12em] ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`}>
            {t('observationDetail.objectPanel.alsoKnownAs')}
          </span>
          {alsoKnownAs.map(aka => (
            <span
              key={aka}
              className={`rounded-md px-2 py-0.5 text-[0.75rem] font-medium ${
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
          className={`mt-4 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium transition hover:underline ${accentText}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('observationDetail.objectPanel.readOnWikipedia')}
        </a>
      )}
    </SessionPanel>
  );
}
