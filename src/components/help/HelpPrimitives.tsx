/**
 * Shared content primitives used inside help articles.
 *
 * Every primitive reads the active theme via useTheme so it adapts to
 * light / dark / night / space without ceremony at the call site.
 */

import { useState, type ReactNode } from 'react';
import { CheckCircle2, Info, AlertTriangle, ChevronDown } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

/* ─────────────────────────────────────────────────────────────────────────
 * Callout — coloured advice box. Three variants for tip / note / warning.
 * ───────────────────────────────────────────────────────────────────────── */

export function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: 'tip' | 'note' | 'warning';
  title?: string;
  children: ReactNode;
}) {
  const { isDark } = useTheme();

  const variants = {
    tip: {
      wrap: isDark
        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
        : 'bg-emerald-50 border-emerald-200 text-emerald-800',
      icon: <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />,
    },
    note: {
      wrap: isDark
        ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
        : 'bg-blue-50 border-blue-200 text-blue-800',
      icon: <Info className="w-4 h-4 shrink-0 mt-0.5" />,
    },
    warning: {
      wrap: isDark
        ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
        : 'bg-amber-50 border-amber-200 text-amber-800',
      icon: <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />,
    },
  };
  const v = variants[type];

  return (
    <div className={`flex gap-3 p-3.5 rounded-lg border text-sm leading-relaxed my-4 ${v.wrap}`}>
      {v.icon}
      <div className="min-w-0">
        {title && <span className="font-semibold mr-1">{title}:</span>}
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Steps — numbered procedure with a vertical rail.
 * ───────────────────────────────────────────────────────────────────────── */

export function Steps({ steps }: { steps: { title: string; body?: ReactNode }[] }) {
  const { isDark } = useTheme();
  return (
    <ol className="flex flex-col gap-0 my-5">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div className="w-7 h-7 rounded-full bg-accent-500 text-white text-xs font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-px flex-1 my-1 ${isDark ? 'bg-slate-700/50' : 'bg-slate-300'}`} />
            )}
          </div>
          <div className="pb-5 pt-0.5 flex-1 min-w-0">
            <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              {step.title}
            </p>
            {step.body && (
              <div className={`text-sm mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {step.body}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * KvTable — bordered key/value reference table (system requirements,
 * file locations, ranking weights, etc).
 * ───────────────────────────────────────────────────────────────────────── */

export function KvTable({
  title,
  rows,
  monoValues = false,
}: {
  title?: string;
  rows: [string, ReactNode][];
  monoValues?: boolean;
}) {
  const { isDark } = useTheme();
  const card = isDark ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-white';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const muted = isDark ? 'text-slate-500' : 'text-slate-500';
  const accent = isDark ? 'text-accent-400' : 'text-accent-700';

  return (
    <div className={`rounded-xl border overflow-hidden my-5 ${card}`}>
      {title && (
        <div className={`px-4 py-2 border-b text-xs font-bold uppercase tracking-wider ${muted} ${divider}`}>
          {title}
        </div>
      )}
      {rows.map(([k, v], i) => (
        <div
          key={k}
          className={`flex gap-3 px-4 py-2.5 text-sm ${i < rows.length - 1 ? `border-b ${divider}` : ''}`}
        >
          <span className={`font-semibold w-44 shrink-0 ${heading}`}>{k}</span>
          <span className={`min-w-0 ${monoValues ? `font-mono text-xs ${accent}` : body}`}>{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * CompareTable — N columns, used for "Docker vs Windows vs macOS" style
 * comparisons. First column is the row label.
 * ───────────────────────────────────────────────────────────────────────── */

export function CompareTable({
  columns,
  rows,
}: {
  columns: string[]; // e.g. ['', 'Docker', 'Windows', 'macOS']
  rows: ReactNode[][]; // each row: same length as columns
}) {
  const { isDark } = useTheme();
  const card = isDark ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-white';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const muted = isDark ? 'text-slate-500' : 'text-slate-500';
  const cols = `repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <div className={`rounded-xl border overflow-hidden my-5 ${card}`}>
      <div
        className={`grid gap-0 px-4 py-2.5 border-b text-xs font-bold uppercase tracking-wider ${muted} ${divider}`}
        style={{ gridTemplateColumns: cols }}
      >
        {columns.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          className={`grid gap-0 px-4 py-2.5 text-sm items-start ${i < rows.length - 1 ? `border-b ${divider}` : ''}`}
          style={{ gridTemplateColumns: cols }}
        >
          {row.map((cell, j) => (
            <span key={j} className={j === 0 ? `font-medium text-xs ${heading}` : `text-xs ${body}`}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Code — inline monospace token. Picks tokens-friendly colours per theme.
 * ───────────────────────────────────────────────────────────────────────── */

export function Code({ children }: { children: ReactNode }) {
  const { isDark } = useTheme();
  return (
    <code
      className={`px-1.5 py-0.5 rounded text-xs font-mono ${
        isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-700'
      }`}
    >
      {children}
    </code>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Prose — wraps a block of body copy with consistent spacing/typography.
 * Use as the default container for paragraph content inside an article.
 * ───────────────────────────────────────────────────────────────────────── */

export function Prose({ children }: { children: ReactNode }) {
  const { isDark } = useTheme();
  return (
    <div
      className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
      style={{ textWrap: 'pretty' as const }}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Faq — collapsible question/answer row used by both the hub and topic pages.
 * Uncontrolled by default; pass open/onToggle to control.
 * ───────────────────────────────────────────────────────────────────────── */

export function Faq({
  q,
  children,
  defaultOpen = false,
}: {
  q: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const { isDark } = useTheme();
  const [open, setOpen] = useState(defaultOpen);

  const wrap = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const wrapOpen = open ? 'shadow-md border-accent-500/40' : '';
  const heading = isDark ? 'text-slate-100' : 'text-slate-800';
  const hover = isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50';
  const answer = isDark ? 'text-slate-400 border-slate-800' : 'text-slate-500 border-slate-100';

  return (
    <div className={`rounded-xl border overflow-hidden transition-shadow ${wrap} ${wrapOpen}`}>
      <button
        className={`w-full flex items-center justify-between gap-4 px-5 py-4 text-left transition-colors ${hover}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className={`text-sm font-semibold ${heading}`}>{q}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className={`px-5 pb-5 pt-0 text-sm leading-relaxed border-t ${answer}`}>
          <div className="pt-4">{children}</div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Theme tone tokens — keyed by topic.tone, used by hub cards + reader chrome.
 * Centralised so a topic's colour is consistent everywhere it appears.
 * ───────────────────────────────────────────────────────────────────────── */

type Tone = 'amber' | 'violet' | 'cyan' | 'rose' | 'emerald' | 'sky' | 'orange' | 'slate';

export function toneClasses(tone: Tone, isDark: boolean) {
  // text + bg tokens for an icon "chip" + a subtle wash for the card
  const map: Record<Tone, { chipBg: string; chipText: string; ring: string; wash: string }> = {
    amber: {
      chipBg: isDark ? 'bg-amber-500/15' : 'bg-amber-100',
      chipText: isDark ? 'text-amber-300' : 'text-amber-700',
      ring: isDark ? 'hover:border-amber-500/40' : 'hover:border-amber-300',
      wash: isDark ? 'from-amber-500/8' : 'from-amber-100/70',
    },
    violet: {
      chipBg: isDark ? 'bg-violet-500/15' : 'bg-violet-100',
      chipText: isDark ? 'text-violet-300' : 'text-violet-700',
      ring: isDark ? 'hover:border-violet-500/40' : 'hover:border-violet-300',
      wash: isDark ? 'from-violet-500/8' : 'from-violet-100/70',
    },
    cyan: {
      chipBg: isDark ? 'bg-cyan-500/15' : 'bg-cyan-100',
      chipText: isDark ? 'text-cyan-300' : 'text-cyan-700',
      ring: isDark ? 'hover:border-cyan-500/40' : 'hover:border-cyan-300',
      wash: isDark ? 'from-cyan-500/8' : 'from-cyan-100/70',
    },
    rose: {
      chipBg: isDark ? 'bg-rose-500/15' : 'bg-rose-100',
      chipText: isDark ? 'text-rose-300' : 'text-rose-700',
      ring: isDark ? 'hover:border-rose-500/40' : 'hover:border-rose-300',
      wash: isDark ? 'from-rose-500/8' : 'from-rose-100/70',
    },
    emerald: {
      chipBg: isDark ? 'bg-emerald-500/15' : 'bg-emerald-100',
      chipText: isDark ? 'text-emerald-300' : 'text-emerald-700',
      ring: isDark ? 'hover:border-emerald-500/40' : 'hover:border-emerald-300',
      wash: isDark ? 'from-emerald-500/8' : 'from-emerald-100/70',
    },
    sky: {
      chipBg: isDark ? 'bg-sky-500/15' : 'bg-sky-100',
      chipText: isDark ? 'text-sky-300' : 'text-sky-700',
      ring: isDark ? 'hover:border-sky-500/40' : 'hover:border-sky-300',
      wash: isDark ? 'from-sky-500/8' : 'from-sky-100/70',
    },
    orange: {
      chipBg: isDark ? 'bg-orange-500/15' : 'bg-orange-100',
      chipText: isDark ? 'text-orange-300' : 'text-orange-700',
      ring: isDark ? 'hover:border-orange-500/40' : 'hover:border-orange-300',
      wash: isDark ? 'from-orange-500/8' : 'from-orange-100/70',
    },
    slate: {
      chipBg: isDark ? 'bg-slate-500/15' : 'bg-slate-200',
      chipText: isDark ? 'text-slate-300' : 'text-slate-700',
      ring: isDark ? 'hover:border-slate-500/40' : 'hover:border-slate-400',
      wash: isDark ? 'from-slate-500/8' : 'from-slate-100/70',
    },
  };
  return map[tone];
}
