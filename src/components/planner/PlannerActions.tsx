/**
 * The planner's page-level actions, sharing the night-picker's row.
 *
 * Only the wishlist is left here, since it is not about any one night. The
 * visible-sky mask belongs to the observing site, so its button
 * (`VisibleSkyButton`) sits beside the site picker in the page header. Copying
 * the last night and sharing the plan act on the schedule, so they sit in the
 * schedule's own header and empty state. "Plan my night" is the one action
 * that belongs to the night itself, and it stays on the hero.
 *
 * Sized to match the night chips so the whole row reads as one band of
 * controls. The label drops away as the row tightens; the accessible name is
 * on the button at every width.
 */
import type { ReactNode } from 'react';
import { Compass, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  isDark: boolean;
  wishlistCount: number;
  onOpenWishlist: () => void;
}

export function PlannerActions({ isDark, wishlistCount, onOpenWishlist }: Props) {
  const { t } = useTranslation('planner');
  return (
    <div className="flex items-center gap-2">
      <ActionButton
        isDark={isDark}
        onClick={onOpenWishlist}
        label={t('plannerActions.wishlist')}
        title={t('plannerActions.wishlistTitle')}
        icon={<Star className="h-4 w-4" />}
        hint={wishlistCount > 0 ? String(wishlistCount) : undefined}
      />
    </div>
  );
}

/**
 * The visible-sky mask belongs to the observing site, so this sits next to the
 * site picker on the page header. That panel is dark in every theme, so the
 * button is styled for the dark side. "Not set" is tinted, because until it is
 * set every target counts as visible.
 */
export function VisibleSkyButton({ onClick, skyLabel, isSet }: { onClick: () => void; skyLabel: string; isSet: boolean }) {
  const { t } = useTranslation('planner');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('plannerActions.visibleSky')}
      title={t('plannerActions.visibleSkyTitle', { skyLabel })}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition ${
        isSet
          ? 'bg-white/[0.06] text-white/70 ring-white/10 hover:bg-white/10 hover:text-white'
          : 'bg-amber-500/10 text-amber-300 ring-amber-400/25 hover:bg-amber-500/20'
      }`}
    >
      <Compass className="h-3.5 w-3.5" />
      <span className="hidden md:inline">{t('plannerActions.visibleSky')}</span>
      <span className="hidden tabular-nums opacity-70 xl:inline">{skyLabel}</span>
    </button>
  );
}

function ActionButton({
  isDark,
  onClick,
  label,
  title,
  icon,
  hint,
  disabled,
}: {
  isDark: boolean;
  onClick: () => void;
  label: string;
  title: string;
  icon: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium ring-1 ring-inset transition disabled:opacity-40 lg:h-[58px] lg:px-3.5 ${
        isDark
          ? 'bg-slate-900 text-slate-300 ring-slate-800 hover:bg-slate-800 hover:text-slate-100'
          : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
      {hint && (
        <span className={`hidden text-[0.6875rem] xl:inline ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {hint}
        </span>
      )}
    </button>
  );
}
