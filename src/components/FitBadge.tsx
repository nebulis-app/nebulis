/**
 * Small colored chip summarizing `classifyFit`'s verdict — "does this object
 * fit my telescope's frame" — for use anywhere that's too tight for the full
 * Framing & Mosaic modal: the Planner target list, the quick session-details
 * peek, etc. See `src/lib/telescopeFov.ts` for the classification logic.
 */
import type { FitTag } from '../lib/telescopeFov';

const FIT_TAG_STYLE: Record<FitTag, { light: string; dark: string }> = {
  fits: {
    light: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dark: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  },
  tight: {
    light: 'bg-amber-50 text-amber-700 border-amber-200',
    dark: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
  mosaic: {
    light: 'bg-orange-50 text-orange-700 border-orange-200',
    dark: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  },
  tiny: {
    light: 'bg-slate-100 text-slate-600 border-slate-200',
    dark: 'bg-slate-800 text-slate-400 border-slate-700',
  },
};

interface FitBadgeProps {
  tag: FitTag;
  /** Chip text — pass `short` from `classifyFit`'s result. */
  label: string;
  /** Longer explanation shown as a native tooltip — pass `label` from `classifyFit`. */
  title?: string;
  isDark: boolean;
  className?: string;
}

export function FitBadge({ tag, label, title, isDark, className = '' }: FitBadgeProps) {
  const style = FIT_TAG_STYLE[tag];
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-none whitespace-nowrap ${
        isDark ? style.dark : style.light
      } ${className}`}
    >
      {label}
    </span>
  );
}
