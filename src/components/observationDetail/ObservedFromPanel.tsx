import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, Image as ImageIcon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getSites, reassignSessionSite } from '../../lib/api/sites';

/**
 * Where this session was captured from, with a dropdown to change it.
 *
 * The list is not just the user's saved sites. When the capture files recorded
 * coordinates, "From image data" is the first option and the default: you can
 * image from somewhere once without creating a saved observing site for it,
 * which is the common case for a trip. Picking a real site overrides the files
 * (for a scope whose GPS was unset or wrong), and picking "From image data"
 * again clears that override, so the choice is never a one-way door.
 *
 * Changing this invalidates the session's cached weather server-side (it was
 * fetched at the old coordinates) and re-fetches at the new ones, so the
 * Conditions rows update a moment after this saves.
 */
const FILE_OPTION = '__file__';

export function ObservedFromControl({
  objectId,
  date,
  siteId,
  fileCoordinates,
  isAdmin,
}: {
  objectId: string;
  date: string;
  /** The session's explicit tag. Null = untagged, so the files decide. */
  siteId: string | null;
  /** What the capture files recorded, or null if they carried no location. */
  fileCoordinates: { lat: number; lon: number } | null;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: getSites });

  const mutation = useMutation({
    mutationFn: (value: string) =>
      reassignSessionSite(objectId, date, value === FILE_OPTION ? null : value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      queryClient.invalidateQueries({ queryKey: ['observation-locations'] });
    },
  });

  const hasFileLocation = fileCoordinates !== null;

  // Untagged with no file location still resolves to the default site, so that
  // is what the control shows selected.
  const selected = siteId
    ?? (hasFileLocation ? FILE_OPTION : sites.find(s => s.isDefault)?.id ?? null);

  const options: Array<{ value: string; label: string; hint?: string; fromFile?: boolean }> = [
    ...(hasFileLocation
      ? [{
        value: FILE_OPTION,
        label: 'From image data',
        hint: `${fileCoordinates.lat.toFixed(2)}°, ${fileCoordinates.lon.toFixed(2)}°`,
        fromFile: true,
      }]
      : []),
    ...sites.map(s => ({
      value: s.id,
      label: s.name,
      hint: s.isDefault ? 'Default' : undefined,
    })),
  ];

  // Nothing to choose between, so the control would only restate the label the
  // Location card already shows under the map.
  if (options.length <= 1) return null;

  return (
    <div>
      <ObservedFromDropdown
        isDark={isDark}
        isAdmin={isAdmin}
        options={options}
        selected={selected}
        open={open}
        setOpen={setOpen}
        isPending={mutation.isPending}
        onSelect={(value) => { mutation.mutate(value); setOpen(false); }}
      />
      {mutation.isError && (
        <p className="mt-2 text-xs text-red-400">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to update location.'}
        </p>
      )}
    </div>
  );
}

interface LocationOption {
  value: string;
  label: string;
  hint?: string;
  fromFile?: boolean;
}

function ObservedFromDropdown({
  isDark,
  isAdmin,
  options,
  selected,
  open,
  setOpen,
  isPending,
  onSelect,
}: {
  isDark: boolean;
  isAdmin: boolean;
  options: LocationOption[];
  selected: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  isPending: boolean;
  onSelect: (value: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), { closeOnEscape: true });

  const current = options.find(o => o.value === selected);
  const label = current?.label ?? 'Default site';

  if (!isAdmin) {
    return (
      <p className={`text-sm flex items-center gap-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
        {current?.fromFile && <ImageIcon className="w-3.5 h-3.5 shrink-0 opacity-60" />}
        {label}
      </p>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={isPending}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm border transition disabled:opacity-50 ${
          isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
          {!isPending && current?.fromFile && <ImageIcon className="w-3.5 h-3.5 shrink-0 opacity-60" />}
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          className={`absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border shadow-lg py-1 ${
            isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
          }`}
        >
          {options.map((option, i) => (
            <li key={option.value}>
              {/* A rule under the file option separates "what the camera said"
                  from the saved sites, which are a different kind of answer. */}
              {i > 0 && options[i - 1].fromFile && (
                <div className={`my-1 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`} />
              )}
              <button
                type="button"
                onClick={() => onSelect(option.value)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between gap-2 ${
                  option.value === selected
                    ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-900'
                    : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {option.fromFile && <ImageIcon className="w-3.5 h-3.5 shrink-0 opacity-60" />}
                  <span className="truncate">{option.label}</span>
                </span>
                {option.hint && (
                  <span className={`text-xs shrink-0 tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {option.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
