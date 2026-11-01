/**
 * The wishlist as a small popup, opened from the Planner toolbar. Reuses the
 * Planner's own live scheduling handlers (it's rendered inside PlannerPage),
 * so "Schedule" and "Add all visible tonight" here are exactly the same
 * placement logic the timeline's own quick-add uses.
 *
 * The "Open full Wishlist" button hands off to the Wishlist tab on Explore
 * (`/explore?tab=wishlist`), for when the list itself is the task (sorting,
 * bulk cleanup, finding more) rather than a quick check mid-session. That tab
 * is self-contained (fetches its own night/session data) rather than reusing
 * these props, since navigating there unmounts this component. It's a
 * labeled button rather than a bare icon, and uses ExternalLink rather than
 * Maximize2, so it doesn't read as "fullscreen this popup in place" — it
 * genuinely navigates away.
 */
import { ExternalLink, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WishlistList, type WishlistListProps } from './WishlistList';

interface Props extends WishlistListProps {
  onExpand: () => void;
  onClose: () => void;
}

export function WishlistPanel({ onExpand, onClose, ...listProps }: Props) {
  const { t } = useTranslation('planner');
  const { items } = listProps;
  const surface = listProps.isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900';
  const subtle = listProps.isDark ? 'text-slate-400' : 'text-slate-600';
  const border = listProps.isDark ? 'border-slate-800' : 'border-slate-200';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`relative rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col ${surface}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        {/* Header */}
        <div className={`shrink-0 px-5 py-4 border-b ${border} bg-gradient-to-r from-amber-500/10 to-transparent`}>
          <div className="flex items-center gap-3">
            <Star className="w-5 h-5 text-amber-500 fill-amber-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{t('wishlistPanel.title')}</h2>
              <p className={`text-xs ${subtle}`}>{t('wishlistPanel.subtitle', { count: items.length })}</p>
            </div>
            <button
              onClick={onExpand}
              className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${listProps.isDark ? 'text-slate-300 hover:bg-white/10 hover:text-slate-100' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
              aria-label={t('wishlistPanel.expand')}
              title={t('wishlistPanel.expand')}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('wishlistPanel.expand')}</span>
            </button>
            <button
              onClick={onClose}
              className={`shrink-0 p-2 rounded-lg transition ${listProps.isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`}
              aria-label={t('wishlistPanel.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 px-5 py-3 overflow-y-auto">
          <WishlistList {...listProps} />
        </div>
      </div>
    </div>
  );
}
