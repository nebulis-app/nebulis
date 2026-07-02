import type { ByTypeStats, ObjectClass } from '../../lib/api/catalogs';

interface Props {
  label: string;
  total: number;
  imagedCount: number;
  byType: ByTypeStats;
  filter: 'all' | 'imaged' | 'remaining';
  onFilterChange: (f: 'all' | 'imaged' | 'remaining') => void;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}

const TYPE_LABELS: Record<ObjectClass, string> = {
  galaxy: 'Galaxies',
  nebula: 'Nebulae',
  cluster: 'Clusters',
  other: 'Other',
};

const TYPE_COLORS: Record<ObjectClass, { bar: string; text: string }> = {
  galaxy: { bar: 'bg-violet-500',  text: 'text-violet-400' },
  nebula: { bar: 'bg-cyan-500',    text: 'text-cyan-400' },
  cluster:{ bar: 'bg-amber-500',   text: 'text-amber-400' },
  other:  { bar: 'bg-slate-500',   text: 'text-slate-400' },
};

const TYPE_ORDER: ObjectClass[] = ['galaxy', 'nebula', 'cluster', 'other'];

export function ProgressHeader({
  label, total, imagedCount, byType,
  filter, onFilterChange,
  isDark, isNight, isSpace,
}: Props) {
  const pct = total > 0 ? Math.round((imagedCount / total) * 100) : 0;
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';
  const accentGlow = isNight ? 'drop-shadow-[0_0_6px_rgba(248,113,113,0.6)]' : isSpace ? 'drop-shadow-[0_0_6px_rgba(167,139,250,0.6)]' : 'drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]';

  // SVG ring
  const r = 52;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  const filterBtnClass = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
      active
        ? isDark
          ? 'bg-slate-700 text-white'
          : 'bg-slate-200 text-slate-900'
        : isDark
          ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className={`border-b ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'} backdrop-blur-xl`}>
      <div className="max-w-7xl mx-auto px-6 py-5">
        <div className="flex flex-wrap items-start gap-8">

          {/* Progress ring */}
          <div className="flex items-center gap-5 shrink-0">
            <div className="relative w-32 h-32">
              <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                <circle
                  cx="60" cy="60" r={r}
                  fill="none"
                  strokeWidth="8"
                  className={isDark ? 'stroke-slate-800' : 'stroke-slate-200'}
                />
                <circle
                  cx="60" cy="60" r={r}
                  fill="none"
                  strokeWidth="8"
                  strokeDasharray={circ}
                  strokeDashoffset={offset}
                  strokeLinecap="round"
                  className={`transition-all duration-700 ${
                    isNight ? 'stroke-red-400' : isSpace ? 'stroke-violet-400' : 'stroke-amber-400'
                  } ${accentGlow}`}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-2xl font-bold font-display leading-none ${accentText}`}>{pct}%</span>
                <span className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>imaged</span>
              </div>
            </div>

            <div>
              <div className={`text-3xl font-display font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {imagedCount}
                <span className={`text-xl font-medium ml-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>/ {total}</span>
              </div>
              <div className={`text-sm mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {label} objects imaged
              </div>
              <div className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {total - imagedCount} remaining
              </div>
            </div>
          </div>

          {/* Type breakdown */}
          <div className="flex-1 min-w-[260px]">
            <div className={`text-xs font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              By object type
            </div>
            <div className="space-y-2">
              {TYPE_ORDER.map((cls) => {
                const { imaged, total: t } = byType[cls];
                const barPct = t > 0 ? (imaged / t) * 100 : 0;
                const { bar, text } = TYPE_COLORS[cls];
                return (
                  <div key={cls} className="flex items-center gap-3">
                    <div className={`w-16 text-[11px] font-medium ${text}`}>{TYPE_LABELS[cls]}</div>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-slate-800/40">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${bar}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <div className={`text-[11px] tabular-nums w-10 text-right ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {imaged}/{t}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Filter tabs (aligned right) */}
          <div className="flex items-center gap-1 self-start">
            {(['all', 'imaged', 'remaining'] as const).map((f) => (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                className={filterBtnClass(filter === f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
