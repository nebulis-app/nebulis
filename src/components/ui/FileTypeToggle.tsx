export function FileTypeToggle({
  label,
  description,
  checked,
  onChange,
  isDark,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  isDark: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 p-2.5 rounded-lg border transition ${
      isDark ? 'border-slate-800/70' : 'border-slate-100'
    }`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 relative inline-flex h-4 w-7 items-center rounded-full transition shrink-0 ${
          checked ? 'bg-teal-500' : isDark ? 'bg-slate-700' : 'bg-slate-300'
        }`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${
          checked ? 'translate-x-3.5' : 'translate-x-0.5'
        }`} />
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{label}</div>
        <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{description}</p>
      </div>
    </div>
  );
}
