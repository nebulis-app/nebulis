import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapPin, ChevronDown, Check, Settings2 } from 'lucide-react';
import { useClickOutside } from '../hooks/useClickOutside';
import { SiteManagerModal } from './SiteManagerModal';
import type { ObservingSite } from '../lib/api/sites';

/**
 * The location pill used on Planner and Forecast.
 *
 * Always renders as an interactive button, even with a single site — a
 * plain-text label with no chevron gave no hint that multiple sites were
 * possible at all, so nobody discovered the feature. Opening it shows the
 * current site(s) for a quick switch, plus "Manage locations..." which opens
 * the full manager (add/edit/delete/set-default/set-visible-sky) right here
 * without a detour through Settings.
 */
export function SitePicker({
  isDark,
  accentText,
  sites,
  currentSite,
  fallbackLabel,
  onSelect,
  isSwitching,
}: {
  isDark: boolean;
  accentText: string;
  sites: ObservingSite[];
  currentSite: ObservingSite | null;
  /** Shown when there is no named site to display (e.g. coordinates only). */
  fallbackLabel: string;
  onSelect: (siteId: string) => void;
  isSwitching?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  useClickOutside([wrapRef, menuRef], () => setOpen(false), { closeOnEscape: true });

  // The menu is portaled to <body> (see below) so it can escape the hero
  // panel's `overflow-hidden`, which otherwise clips it whenever the list is
  // taller than the remaining hero space. Portaling means it's no longer
  // positioned by the wrapper's `relative`, so track the trigger's viewport
  // rect ourselves and keep it in sync while open.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const label = currentSite?.name || fallbackLabel;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={isSwitching}
        title={sites.length > 1 ? 'Switch observing site' : 'Manage observing sites'}
        // A persistent border + background, not just a hover state — without
        // it, the pill reads as plain status text (like "Saved" or the moon
        // phase next to it) rather than something you can click.
        className={`flex items-center gap-1.5 text-sm rounded-full pl-2 pr-2.5 py-1 border transition disabled:opacity-50 ${
          isDark
            ? 'bg-slate-800/60 border-slate-700 text-slate-200 hover:bg-slate-800 hover:border-slate-600'
            : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200/70 hover:border-slate-300'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <MapPin className={`w-4 h-4 shrink-0 ${accentText}`} />
        <span className="font-medium">{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''} ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
        />
      </button>
      {open && menuPos && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
          className={`z-20 min-w-[15rem] max-h-72 overflow-auto rounded-xl border shadow-lg py-1 ${
            isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
          }`}
        >
          {sites.length > 1 && (
            <li className={`px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Observing sites
            </li>
          )}
          {sites.map(site => (
            <li key={site.id}>
              <button
                type="button"
                onClick={() => { onSelect(site.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${
                  site.id === currentSite?.id
                    ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-900'
                    : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                {site.id === currentSite?.id && <Check className="w-3.5 h-3.5 shrink-0" />}
                <span className={site.id === currentSite?.id ? '' : 'ml-[1.375rem]'}>{site.name}</span>
              </button>
            </li>
          ))}
          <li className={`my-1 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`} />
          <li>
            <button
              type="button"
              onClick={() => { setOpen(false); setShowManager(true); }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${
                isDark ? 'text-teal-400 hover:bg-slate-800' : 'text-teal-600 hover:bg-slate-50'
              }`}
            >
              <Settings2 className="w-3.5 h-3.5 shrink-0" />
              Manage locations...
            </button>
          </li>
        </ul>,
        document.body,
      )}
      {showManager && (
        <SiteManagerModal isDark={isDark} onClose={() => setShowManager(false)} />
      )}
    </div>
  );
}
