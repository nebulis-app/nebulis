/** Shared Tailwind class builders for form inputs, labels and helper text. */

export function getInputClass(isDark: boolean): string {
  return `w-full px-4 py-2.5 rounded-xl border text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
    isDark
      ? 'bg-slate-800/80 border-slate-700/80 text-slate-200 placeholder-slate-600 focus:border-accent-500/40'
      : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-accent-400'
  }`;
}

export function getLabelClass(isDark: boolean): string {
  return `block text-[0.8125rem] font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`;
}

export function getHelperClass(isDark: boolean): string {
  return `text-xs mt-1.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
}
