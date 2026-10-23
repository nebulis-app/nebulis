import { useTranslation } from 'react-i18next';
import type { ExploreVisibility } from '../../lib/api/explore';
import { monthLabel } from '../../lib/exploreFormat';

interface Props {
  visibility: ExploreVisibility | null;
  isDark: boolean;
  /** Overlaid on a photo: use opaque, high-contrast colours. */
  onImage?: boolean;
  /** "Up tonight", or "Up on Sat, Oct 11" when Explore is showing another night. */
  upLabel?: string;
}

/**
 * One chip answering "can I shoot this from here?". The first rule that
 * matches wins: up tonight, then in season (with the best months), then low
 * from here, then never rises. No chip at all when no location is known,
 * because a chip that says nothing would still read as an answer.
 */
export function VisibilityChip({ visibility, isDark, onImage = false, upLabel }: Props) {
  const { t, i18n } = useTranslation('catalogs');
  if (!visibility) return null;

  let label: string;
  let tone: string;
  switch (visibility.kind) {
    case 'tonight':
      label = upLabel ?? t('explore.visibility.tonight');
      tone = onImage ? 'bg-emerald-500 text-white' : isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-800';
      break;
    case 'season':
      label = visibility.bestFrom && visibility.bestTo
        ? visibility.bestFrom === visibility.bestTo
          ? t('explore.visibility.bestMonth', { month: monthLabel(visibility.bestFrom, i18n.language) })
          : t('explore.visibility.bestRange', { from: monthLabel(visibility.bestFrom, i18n.language), to: monthLabel(visibility.bestTo, i18n.language) })
        : t('explore.visibility.inSeason');
      tone = onImage ? 'bg-slate-900/80 text-slate-100' : isDark ? 'bg-slate-700/60 text-slate-200' : 'bg-slate-100 text-slate-700';
      break;
    case 'low':
      label = t('explore.visibility.low');
      tone = onImage ? 'bg-amber-500 text-white' : isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-800';
      break;
    default:
      label = t('explore.visibility.never');
      tone = onImage ? 'bg-slate-900/80 text-slate-400' : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400';
  }

  return (
    <span className={`inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${tone}`}>
      {label}
    </span>
  );
}
