import { AlertTriangle, Check, HardDrive, Server, type LucideIcon } from 'lucide-react';

import type { ArchiveDestinationState } from '../../lib/api/storage';

/** House button and surface styles, matching the other Storage sections
 *  (`DatabaseBackupsSection`) so the archive does not read as a different app. Filled
 *  buttons, not outlined ones: outline is not used for section actions anywhere else. */
export function archiveStyles(isDark: boolean) {
  const btnBase =
    'px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  return {
    btnBase,
    btnPrimary: 'bg-accent-500 text-white hover:bg-accent-600',
    // One step brighter than the card and the open-row tint, which are both slate-800
    // territory in the dark theme: a slate-800 button vanished into the open row.
    btnSubtle: isDark
      ? 'bg-slate-700 text-slate-100 hover:bg-slate-600'
      : 'bg-slate-200 text-slate-700 hover:bg-slate-300',
    divider: isDark ? 'border-slate-800/70' : 'border-slate-100',
    subText: isDark ? 'text-slate-500' : 'text-slate-400',
    strongText: isDark ? 'text-slate-200' : 'text-slate-800',
    noticeClass: `rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
      isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'
    }`,
    errorClass: `rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
      isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
    }`,
    warningClass: `flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
      isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
    }`,
    dangerBox: `rounded-xl border p-4 ${
      isDark ? 'border-red-500/25 bg-red-500/[0.07]' : 'border-red-200 bg-red-50/80'
    }`,
  };
}

/** Icon for each destination state, so "is this disk mine?" is answered by shape and
 *  colour as well as by the sentence. Mirrors the drive badges in
 *  `LibraryLocationSection`. */
export const STATE_ICON: Record<ArchiveDestinationState, LucideIcon> = {
  unconfigured: HardDrive,
  'invalid-path': AlertTriangle,
  // A share that is configured and not connected. Drawn as a server rather than a
  // drive, because that is what the user has to go and check.
  offline: Server,
  absent: HardDrive,
  match: Check,
  foreign: HardDrive,
  invalid: AlertTriangle,
  unreadable: AlertTriangle,
};

export function stateColor(state: ArchiveDestinationState | null, isDark: boolean): string {
  switch (state) {
    case 'match':
      return isDark ? 'text-emerald-400' : 'text-emerald-700';
    case 'absent':
    case 'foreign':
    case 'offline':
      return isDark ? 'text-amber-400' : 'text-amber-700';
    case 'invalid':
    case 'unreadable':
    case 'invalid-path':
      return isDark ? 'text-red-400' : 'text-red-700';
    default:
      return isDark ? 'text-slate-500' : 'text-slate-400';
  }
}

/** The states a run or an adopt would be refused in, so the wizard does not walk on. */
export function isUnusableState(state: ArchiveDestinationState | null): boolean {
  return state === 'invalid' || state === 'unreadable' || state === 'invalid-path' || state === 'offline';
}
