/**
 * What the 0-100 rating means, and what goes into it.
 *
 * Shared by the Sky Forecast page and the planner's weather popup, so the
 * bands can never be described differently in the two places they appear.
 */
const BANDS = [
  { color: 'bg-emerald-400', label: '85+ Ideal' },
  { color: 'bg-emerald-500', label: '70+ Great' },
  { color: 'bg-blue-400', label: '55+ Good' },
  { color: 'bg-amber-400', label: '40+ Fair' },
  { color: 'bg-orange-500', label: '25+ Poor' },
  { color: 'bg-red-500', label: 'Under 25 Bad' },
];

export function RatingLegend({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border px-4 py-3 text-[11px] ${
      isDark ? 'bg-slate-900/60 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'
    }`}>
      <span className={`font-medium uppercase tracking-[0.14em] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        Rating
      </span>
      {BANDS.map(b => (
        <span key={b.label} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${b.color}`} />
          {b.label}
        </span>
      ))}
      <span className="basis-full">
        Cloud cover 60%, seeing and jet stream 20%, Moon 20%, plus a humidity bonus. Click or arrow along the ribbon for an hour.
      </span>
    </div>
  );
}
