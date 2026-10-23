import { useTranslation } from 'react-i18next';

/**
 * What the 0-100 rating means, and what goes into it.
 *
 * Shared by the Sky Forecast page and the planner's weather popup, so the
 * bands can never be described differently in the two places they appear.
 */
const BANDS = [
  { color: 'bg-emerald-400', threshold: 85, scoreBandKey: 'ideal', below: false },
  { color: 'bg-emerald-500', threshold: 70, scoreBandKey: 'great', below: false },
  { color: 'bg-blue-400', threshold: 55, scoreBandKey: 'good', below: false },
  { color: 'bg-amber-400', threshold: 40, scoreBandKey: 'fair', below: false },
  { color: 'bg-orange-500', threshold: 25, scoreBandKey: 'poor', below: false },
  { color: 'bg-red-500', threshold: 25, scoreBandKey: 'bad', below: true },
];

export function RatingLegend({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('common');
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border px-4 py-3 text-[0.6875rem] ${
      isDark ? 'bg-slate-900/60 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'
    }`}>
      <span className={`font-medium uppercase tracking-[0.14em] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {t('ratingLegend.heading')}
      </span>
      {BANDS.map(b => {
        const label = t(`scoreBand.${b.scoreBandKey}`);
        const text = b.below
          ? t('ratingLegend.bandBelow', { threshold: b.threshold, label })
          : t('ratingLegend.bandAtLeast', { threshold: b.threshold, label });
        return (
          <span key={`${b.scoreBandKey}-${b.below}`} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${b.color}`} />
            {text}
          </span>
        );
      })}
      <span className="basis-full">
        {t('ratingLegend.explanation')}
      </span>
    </div>
  );
}
