/**
 * The Targets panel's "View" control: how the list is ordered and trimmed, as opposed to the type pills, which pick
 * what is listed. Holds the sort order and the two list toggles so they are one button instead of a dropdown and a
 * second row of pills. A dot on the button says something here is off its default.
 */
import { useRef, useState } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useClickOutside } from '../../hooks/useClickOutside';

export type TargetOrder = 'best' | 'conditions';
/** Which targets to list, apart from their type. */
export type TargetScope = 'all' | 'wishlist' | 'notImaged';

interface LibraryViewMenuProps {
  order: TargetOrder;
  onOrderChange: (next: TargetOrder) => void;
  hideBlocked: boolean;
  onHideBlockedChange: (next: boolean) => void;
  varied: boolean;
  onVariedChange: (next: boolean) => void;
  scope: TargetScope;
  onScopeChange: (next: TargetScope) => void;
  isDark: boolean;
}

export function LibraryViewMenu({
  order, onOrderChange, hideBlocked, onHideBlockedChange, varied, onVariedChange, scope, onScopeChange, isDark,
}: LibraryViewMenuProps) {
  const { t } = useTranslation('planner');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  const customised = order !== 'best' || hideBlocked || varied || scope !== 'all';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const rowClass = `flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition ${
    isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
  }`;

  const orderRow = (value: TargetOrder, label: string, hint: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={order === value}
      onClick={() => onOrderChange(value)}
      className={rowClass}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {order === value && <Check className="h-3.5 w-3.5 text-accent-500" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-xs ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{label}</span>
        <span className={`block text-[0.6875rem] leading-snug ${muted}`}>{hint}</span>
      </span>
    </button>
  );

  const scopeRow = (value: TargetScope, label: string, hint: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={scope === value}
      onClick={() => onScopeChange(value)}
      className={rowClass}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {scope === value && <Check className="h-3.5 w-3.5 text-accent-500" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-xs ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{label}</span>
        <span className={`block text-[0.6875rem] leading-snug ${muted}`}>{hint}</span>
      </span>
    </button>
  );

  const toggleRow = (checked: boolean, onChange: (next: boolean) => void, label: string, hint: string) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={rowClass}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {checked && <Check className="h-3.5 w-3.5 text-accent-500" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-xs ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{label}</span>
        <span className={`block text-[0.6875rem] leading-snug ${muted}`}>{hint}</span>
      </span>
    </button>
  );

  const heading = (text: string) => (
    <div className={`px-2 pb-0.5 pt-1.5 text-[0.625rem] font-semibold uppercase tracking-wide ${muted}`}>{text}</div>
  );

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('libraryPanel.viewLabel')}
        title={t('libraryPanel.viewTitle')}
        className={`relative flex h-full items-center rounded-xl border px-3 transition ${
          open || customised
            ? 'border-accent-500 text-accent-500'
            : isDark
              ? 'border-slate-700 bg-slate-800 text-slate-300 hover:text-slate-100'
              : 'border-slate-200 bg-slate-100 text-slate-600 hover:text-slate-900'
        }`}
      >
        <SlidersHorizontal className="h-4 w-4" />
        <span className="ml-1.5 hidden text-xs @min-[26rem]:inline">{t('libraryPanel.viewButton')}</span>
        {customised && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent-500" />}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('libraryPanel.viewLabel')}
          className={`absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border p-1.5 shadow-xl ${
            isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
          }`}
        >
          {heading(t('libraryPanel.viewShow'))}
          {scopeRow('all', t('libraryPanel.scopeAll'), t('libraryPanel.scopeAllHint'))}
          {scopeRow('wishlist', t('libraryPanel.filterWishlist'), t('libraryPanel.scopeWishlistHint'))}
          {scopeRow('notImaged', t('libraryPanel.scopeNotImaged'), t('libraryPanel.scopeNotImagedHint'))}
          {heading(t('libraryPanel.viewSort'))}
          {orderRow('best', t('libraryPanel.orderBest'), t('libraryPanel.orderBestTitle'))}
          {orderRow('conditions', t('libraryPanel.orderConditions'), t('libraryPanel.orderConditionsTitle'))}
          {heading(t('libraryPanel.viewList'))}
          {toggleRow(hideBlocked, onHideBlockedChange, t('libraryPanel.hideBlocked'), t('libraryPanel.hideBlockedTitle'))}
          {toggleRow(varied, onVariedChange, t('libraryPanel.variedMix'), t('libraryPanel.variedMixTitle'))}
        </div>
      )}
    </div>
  );
}
