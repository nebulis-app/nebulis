/**
 * A small labeled stat in a tile's 2x2 facts grid — max altitude, visibility
 * window, duration, magnitude, etc. Used by the Wishlist grid's cards.
 */
export function StatCell({
  label,
  value,
  isDark,
}: {
  label: string;
  value: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 p-3 rounded-lg ${isDark ? 'bg-slate-800/50' : 'bg-slate-100/70'}`}>
      <span className={`text-[0.5938rem] font-semibold uppercase tracking-[0.16em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        {label}
      </span>
      <span className={`text-sm font-bold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
        {value}
      </span>
    </div>
  );
}
