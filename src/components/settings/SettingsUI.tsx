import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Plus } from 'lucide-react';
import { useClickOutside } from '../../hooks/useClickOutside';

/* ─────────────────────────────────────────────────────────────────────────── */
/* Existing primitives — kept identical in shape so other sections still work. */
/* ─────────────────────────────────────────────────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Accessible name. A `role="switch"` with no name is announced as an anonymous
   *  switch, and it also forces tests to address it by position, which silently
   *  repoints them the moment another toggle is added above. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[42px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent-500' : 'bg-slate-600'
      }`}
    >
      <span
        style={{ backgroundColor: '#fff' }}
        className={`pointer-events-none inline-block h-[18px] w-[18px] rounded-full shadow-sm transition-transform duration-200 ease-in-out ${
          checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}

export { getInputClass, getLabelClass, getHelperClass } from '../ui/formClasses';

/* ─────────────────────────────────────────────────────────────────────────── */
/* New primitives — Sec / Row / Seg / RadioCard. Used by the redesign.        */
/* ─────────────────────────────────────────────────────────────────────────── */

/** A titled section block. Headings sit above a single bordered card. */
export function Sec({
  title,
  description,
  isDark,
  children,
  actions,
}: {
  title: string;
  description?: string;
  isDark: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-0" data-setting-label={title}>
      <div className="flex items-end justify-between gap-6 mb-3 px-1">
        <div className="min-w-0">
          <h3 className={`text-[0.9375rem] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {title}
          </h3>
          {description && (
            <p className={`text-[0.8125rem] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {/* Solid fill, not translucent: at 40% opacity slate-900 sat only ~3
          luminance points above the slate-950 page, so a page with several
          stacked Secs read as one continuous surface with no card edges. A
          solid fill plus a lighter border give each section a real edge,
          which matters once six of these are stacked on one page. */}
      <div
        className={`rounded-2xl border ${
          isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        {children}
      </div>
    </section>
  );
}

/** A single setting row inside a `<Sec>`. Label + helper on the left, control on the right.
 *  Rows stack with a thin divider between them. Last row in a Sec doesn't get a divider.
 *
 *  `description`, when given, no longer prints inline — a whole page of rows each
 *  carrying a full sentence underneath is what made these lists read as a "wall".
 *  Instead it sits behind a small (i) next to the label: hover to preview, click to
 *  pin it open (so it still works on touch, and a click will win over the row's own
 *  height not growing/shifting other rows on hover). */
export function Row({
  label,
  description,
  isDark,
  badge,
  children,
}: {
  label: string;
  description?: string;
  isDark: boolean;
  /** Small pill after the label, e.g. "Beta". */
  badge?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-setting-label={label}
      // The control column used to be WIDER than the text column (1.4fr vs
      // 1fr) even though a Toggle is 42px and right-aligned into empty space,
      // while the label+description column — genuinely prose — was starving
      // for room and wrapping to 2-3 lines regardless of how tightly the
      // description text itself was written. Flipped so text gets the space
      // controls don't need.
      className={`grid grid-cols-1 md:grid-cols-[minmax(220px,2fr)_minmax(0,1fr)] gap-4 md:gap-8 px-5 py-3.5 border-b last:border-b-0 ${
        isDark ? 'border-slate-800/70' : 'border-slate-100'
      }`}
    >
      <div className="min-w-0 flex items-center gap-1.5">
        <div className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          {label}
        </div>
        {badge && (
          <span className={`shrink-0 rounded-full border px-2 py-px text-[0.625rem] font-semibold uppercase tracking-wider ${
            isDark ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-700'
          }`}>
            {badge}
          </span>
        )}
        {description && <InfoTooltip text={description} isDark={isDark} />}
      </div>
      <div className="min-w-0 flex items-center justify-start md:justify-end">
        {children}
      </div>
    </div>
  );
}

/** Off-screen and invisible until the layout effect below places it for
 *  real — avoids a one-frame flash at the stale/default position (`{}` would
 *  render, unpositioned, in normal flow for that frame instead). */
const OFFSCREEN_TOOLTIP_STYLE: CSSProperties = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' };

/** The (i) affordance `Row` uses for its description. Hover previews it;
 *  click pins it open (closes on click-outside or Escape) so it works the
 *  same on touch as it does with a mouse.
 *
 *  Positioned as `fixed` and measured against the actual viewport rather
 *  than a CSS-only `absolute` under the icon: a Row near the bottom of a
 *  long settings page (real report: the last row of Settings → Library's
 *  "Calibration" section, 2026-09-20) opened downward and ran off the
 *  bottom of the screen with no way to scroll it into view. Mirrors
 *  ObservationsCalendar.tsx's `ObservationHoverPreview` flip/clamp math,
 *  adapted for a variable-height box (that one's preview is a fixed size,
 *  so it can compute position before ever rendering; this one's height
 *  depends on the description's own length, so it renders once off-screen
 *  first to measure, then a layout effect repositions it before paint). */
function InfoTooltip({ text, isDark }: { text: string; isDark: boolean }) {
  const { t } = useTranslation('settings');
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>(OFFSCREEN_TOOLTIP_STYLE);
  useClickOutside(ref, () => setPinned(false), { enabled: pinned, closeOnEscape: true });

  const open = hovering || pinned;

  // Recomputed on every open (not just once), since scrolling or resizing
  // between opens can change what actually fits — and, since a click-pinned
  // tooltip can stay open while the page scrolls (unlike a hover preview,
  // which closes the moment the pointer moves away), also re-run on scroll/
  // resize while open so it tracks its anchor instead of drifting away from
  // it (a `fixed`-positioned element doesn't move with page content).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;

    const reposition = () => {
      if (!buttonRef.current || !tooltipRef.current) return;
      const anchor = buttonRef.current.getBoundingClientRect();
      const tooltip = tooltipRef.current.getBoundingClientRect();
      const margin = 8;
      const gap = 6;

      // Below the icon by default; flip above when it doesn't fit below AND
      // there actually is room above — never flip into an even worse clip.
      let top = anchor.bottom + gap;
      if (top + tooltip.height > window.innerHeight - margin) {
        const above = anchor.top - gap - tooltip.height;
        top = above >= margin ? above : Math.max(margin, window.innerHeight - tooltip.height - margin);
      }

      // Left-aligned to the icon by default; slide left just enough to stay
      // clear of the right edge, then clamp the left edge too.
      let left = anchor.left;
      if (left + tooltip.width > window.innerWidth - margin) {
        left = window.innerWidth - tooltip.width - margin;
      }
      left = Math.max(margin, left);

      setStyle({ position: 'fixed', top, left });
    };

    reposition();
    // `capture: true` so a scroll inside any inner scrollable ancestor (the
    // settings page body, a modal) is caught too, not just window-level
    // scroll — those don't bubble to `window` in the 'scroll' event's
    // non-capturing phase.
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t('settingsUI.moreInfoAriaLabel', { text })}
        aria-expanded={open}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        onClick={() => setPinned(p => !p)}
        className={`flex items-center justify-center w-4 h-4 rounded-full transition-colors ${
          isDark ? 'text-slate-600 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          ref={tooltipRef}
          role="tooltip"
          style={style}
          className={`z-20 w-64 rounded-lg border px-3 py-2 text-[0.75rem] leading-relaxed shadow-lg ${
            isDark ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-600'
          }`}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * A label strip that names a run of `Row`s inside a `Sec`.
 *
 * This exists so sub-grouping costs a label rather than a card. Sections used to
 * nest a second bordered card (`getCardClass`) inside `Sec` purely to get a
 * heading over a few related rows, which put every control behind two borders
 * and two radii. Rows that follow this strip read as belonging to it, with no
 * extra chrome.
 *
 * Expects whatever precedes it to supply its own bottom border, which `Row`
 * already does.
 */
export function RowGroup({
  label,
  description,
  isDark,
}: {
  label: string;
  description?: string;
  isDark: boolean;
}) {
  return (
    <div
      className={`px-5 pt-3.5 pb-2.5 border-b ${
        // Tinted darker than the (now solid) card fill, so the strip still
        // reads as a distinct band rather than disappearing into a same-color
        // parent the way a translucent slate-900 would.
        isDark ? 'bg-slate-950/40 border-slate-800' : 'bg-slate-50/70 border-slate-100'
      }`}
    >
      <div className={`text-[0.625rem] font-semibold uppercase tracking-[0.1em] ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {label}
      </div>
      {description && (
        <p className={`text-[0.75rem] mt-1 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          {description}
        </p>
      )}
    </div>
  );
}

/** Segmented control for 2–4 mutually exclusive options. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  isDark,
  disabled = false,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  isDark: boolean;
  /** Inert but visible. Used where a section is switched off as a whole: the
   *  controls stay readable so the user can see what is configured. */
  disabled?: boolean;
}) {
  return (
    <div
      data-segmented
      className={`inline-flex p-0.5 rounded-lg border ${
        isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-100/70 border-slate-200'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      {options.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            className={`px-3 py-1.5 rounded-md text-[0.75rem] font-medium transition-colors ${
              disabled ? 'cursor-not-allowed' : ''
            } ${
              active
                ? isDark
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'bg-white text-slate-900 shadow-sm'
                : isDark
                  ? 'text-slate-400 hover:text-slate-200'
                  : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Larger card-style picker (used for theme selection — supports a preview slot). */
export function RadioCard<T extends string>({
  id,
  active,
  onSelect,
  title,
  description,
  preview,
  isDark,
}: {
  id: T;
  active: boolean;
  onSelect: (id: T) => void;
  title: string;
  description?: string;
  preview?: ReactNode;
  isDark: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className={`text-left rounded-xl border p-3 transition-all duration-150 ${
        active
          ? isDark
            ? 'bg-accent-500/5 border-accent-500/40 ring-1 ring-accent-500/30'
            : 'bg-accent-50/60 border-accent-300 ring-1 ring-accent-200'
          : isDark
            ? 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
            : 'bg-white border-slate-200 hover:border-slate-300'
      }`}
    >
      {preview && (
        <div className={`mb-3 rounded-lg overflow-hidden border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {preview}
        </div>
      )}
      <div className={`text-[0.8125rem] font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
        {title}
      </div>
      {description && (
        <p className={`text-[0.75rem] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          {description}
        </p>
      )}
    </button>
  );
}

/**
 * The full-width "Add ..." button at the foot of a list (telescopes, observing
 * sites). A tinted accent outline: it reads as the pane's main action without
 * a solid fill competing with the toggles and stars in the rows above. Uses
 * the accent-* tokens so it follows the Night and Space themes.
 */
export function AddListButton({
  onClick,
  children,
  isDark,
}: {
  onClick: () => void;
  children: ReactNode;
  isDark: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
        isDark
          ? 'border-accent-500/40 bg-accent-500/10 text-accent-300 hover:border-accent-400/70 hover:bg-accent-500/20'
          : 'border-accent-500/40 bg-accent-500/10 text-accent-700 hover:border-accent-500/70 hover:bg-accent-500/20'
      }`}
    >
      <Plus className="h-4 w-4" />
      {children}
    </button>
  );
}
