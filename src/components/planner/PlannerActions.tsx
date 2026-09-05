/**
 * The planner's secondary actions, sharing the night-picker's row.
 *
 * None of these are about tonight in particular, which is why they sit up here
 * with the navigation rather than on the night panel: the visible-sky mask is a
 * property of the observing site, copying a night and sharing a plan are both
 * after-the-fact. "Plan my night" is the only action that belongs to the night
 * itself, and it stays there.
 *
 * Sized to match the night chips so the whole row reads as one band of
 * controls. Labels and the sky count drop away as the row tightens, so this
 * never wraps onto a line of its own before it has to; the accessible name is
 * on the button at every width.
 */
import type { ReactNode } from 'react';
import { Compass, Copy, Share2 } from 'lucide-react';

interface Props {
  isDark: boolean;
  onEditSky: () => void;
  /** e.g. "272 / 288", or "not set" when the observer has no mask yet. */
  skyLabel: string;
  onCopyPrevious: () => void;
  isCopying: boolean;
  canShare: boolean;
  onShare: () => void;
}

export function PlannerActions({
  isDark,
  onEditSky,
  skyLabel,
  onCopyPrevious,
  isCopying,
  canShare,
  onShare,
}: Props) {
  return (
    <div className="flex items-center gap-2">
      <ActionButton
        isDark={isDark}
        onClick={onEditSky}
        label="Visible sky"
        title={`Set which patches of sky you can actually see (${skyLabel})`}
        icon={<Compass className="h-4 w-4" />}
        hint={skyLabel}
      />
      <ActionButton
        isDark={isDark}
        onClick={onCopyPrevious}
        disabled={isCopying}
        label="Copy last night"
        title="Copy every block from the night before onto this night"
        icon={<Copy className="h-4 w-4" />}
        hint={isCopying ? 'Copying...' : undefined}
      />
      <ActionButton
        isDark={isDark}
        onClick={onShare}
        disabled={!canShare}
        label="Share"
        title={canShare ? "Share this night's plan as text or an image" : 'Nothing scheduled to share yet'}
        icon={<Share2 className="h-4 w-4" />}
      />
    </div>
  );
}

function ActionButton({
  isDark,
  onClick,
  label,
  title,
  icon,
  hint,
  disabled,
}: {
  isDark: boolean;
  onClick: () => void;
  label: string;
  title: string;
  icon: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium ring-1 ring-inset transition disabled:opacity-40 lg:h-[58px] lg:px-3.5 ${
        isDark
          ? 'bg-slate-900 text-slate-300 ring-slate-800 hover:bg-slate-800 hover:text-slate-100'
          : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
      {hint && (
        <span className={`hidden text-[11px] xl:inline ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {hint}
        </span>
      )}
    </button>
  );
}
