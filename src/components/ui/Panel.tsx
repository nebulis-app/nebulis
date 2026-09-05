/**
 * The card shell shared by observationDetail's three session panels (object,
 * conditions, site) and objectDetail's tonight panel, plus the label/value
 * row they all lay their facts out with.
 *
 * These used to be separate cards, each inventing its own type scale, so a
 * magnitude in one and a wind speed in another were set at different sizes
 * for no reason. One shell, one row, one scale.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

export function SessionPanel({ title, icon: Icon, aside, children, className = '' }: {
  title: string;
  icon: LucideIcon;
  /** Right-hand slot in the heading row, for a count or a small control. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  return (
    <section
      className={`flex flex-col rounded-2xl border p-5 ${
        isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white shadow-sm'
      } ${className}`}
    >
      <div className="mb-4 flex items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${accentText}`} />
        <h2 className={`font-display text-[15px] font-semibold tracking-tight ${
          isDark ? 'text-white' : 'text-slate-900'
        }`}>
          {title}
        </h2>
        {aside && <div className="ml-auto min-w-0">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * One fact. The label is small and quiet, the value is the size of body text,
 * because the value is the thing being read. `title` carries an explanation for
 * a unit that needs one (angular size), rendered as a dotted underline.
 */
export function Fact({ label, value, hint }: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  const { isDark } = useTheme();
  return (
    <div className="min-w-0">
      <dt
        title={hint}
        className={`truncate text-[10.5px] font-medium uppercase tracking-[0.12em] ${
          hint ? 'cursor-help underline decoration-dotted underline-offset-2' : ''
        } ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
      >
        {label}
      </dt>
      <dd className={`mt-1 truncate text-[13px] font-medium tabular-nums ${
        isDark ? 'text-slate-200' : 'text-slate-800'
      }`}>
        {value}
      </dd>
    </div>
  );
}

/** Grid the facts sit in. Two columns everywhere, since the labels are long
 *  enough that three would truncate on a phone. */
export function FactGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`grid grid-cols-2 gap-x-5 gap-y-3.5 ${className}`}>{children}</dl>;
}

/** Muted line for a panel that has nothing to show, so the row of panels keeps
 *  its shape instead of collapsing to two. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  const { isDark } = useTheme();
  return (
    <p className={`text-[13px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{children}</p>
  );
}
