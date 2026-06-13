import type { ReactNode } from 'react';

/* ─────────────────────────────────────────────────────────────────────────── */
/* Existing primitives — kept identical in shape so other sections still work. */
/* ─────────────────────────────────────────────────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  isDark,
  icon,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  isDark: boolean;
  icon?: ReactNode;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-4 py-2.5 px-3 rounded-xl cursor-pointer transition-colors duration-150 select-none ${
        isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {icon && (
          <span className={`shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <div className={`text-[13px] font-medium leading-snug ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            {label}
          </div>
          {description && (
            <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {description}
            </p>
          )}
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}

export function getInputClass(isDark: boolean): string {
  return `w-full px-4 py-2.5 rounded-xl border text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
    isDark
      ? 'bg-slate-800/80 border-slate-700/80 text-slate-200 placeholder-slate-600 focus:border-accent-500/40'
      : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-accent-400'
  }`;
}

export function getLabelClass(isDark: boolean): string {
  return `block text-[13px] font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`;
}

export function getHelperClass(isDark: boolean): string {
  return `text-xs mt-1.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
}

export function getCardClass(isDark: boolean): string {
  return `rounded-2xl border p-6 ${
    isDark ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
  }`;
}

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
    <section className="mt-10 first:mt-0">
      <div className="flex items-end justify-between gap-6 mb-3 px-1">
        <div className="min-w-0">
          <h3 className={`text-[15px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {title}
          </h3>
          {description && (
            <p className={`text-[13px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div
        className={`rounded-2xl border ${
          isDark ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        {children}
      </div>
    </section>
  );
}

/** A single setting row inside a `<Sec>`. Label + helper on the left, control on the right.
 *  Rows stack with a thin divider between them. Last row in a Sec doesn't get a divider. */
export function Row({
  label,
  description,
  isDark,
  children,
}: {
  label: string;
  description?: string;
  isDark: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-[minmax(220px,1fr)_minmax(0,1.4fr)] gap-4 md:gap-8 px-5 py-5 border-b last:border-b-0 ${
        isDark ? 'border-slate-800/70' : 'border-slate-100'
      }`}
    >
      <div className="min-w-0">
        <div className={`text-[13px] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          {label}
        </div>
        {description && (
          <p className={`text-[12px] mt-1 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {description}
          </p>
        )}
      </div>
      <div className="min-w-0 flex items-center justify-start md:justify-end">
        {children}
      </div>
    </div>
  );
}

/** Segmented control for 2–4 mutually exclusive options. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  isDark,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  isDark: boolean;
}) {
  return (
    <div
      className={`inline-flex p-0.5 rounded-lg border ${
        isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-100/70 border-slate-200'
      }`}
    >
      {options.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
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
      <div className={`text-[13px] font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
        {title}
      </div>
      {description && (
        <p className={`text-[12px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          {description}
        </p>
      )}
    </button>
  );
}
