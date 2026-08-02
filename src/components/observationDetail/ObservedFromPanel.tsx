import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getSites, reassignSessionSite } from '../../lib/api/sites';

/**
 * Which observing site this session was captured from, with a dropdown to
 * retag it. Renders nothing when there's only one site, since there is nothing
 * to reassign to.
 *
 * This is the control alone, with no card of its own: it sits inside the
 * Location card next to the map. It used to be a separate card, which meant the
 * site name appeared twice on the page under two headings that both carried a
 * map-pin icon.
 *
 * Retagging invalidates the session's cached weather server-side (it was
 * fetched at the old site's coordinates) and kicks off a background refetch
 * at the new ones, so the weather rows update a moment after this saves.
 */
export function ObservedFromControl({
  objectId,
  date,
  siteId,
  isAdmin,
}: {
  objectId: string;
  date: string;
  /** The session's current siteId. Null = the default site. */
  siteId: string | null;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: getSites });

  const currentSite = siteId ? sites.find(s => s.id === siteId) : sites.find(s => s.isDefault);

  const mutation = useMutation({
    mutationFn: (newSiteId: string) => reassignSessionSite(objectId, date, newSiteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      queryClient.invalidateQueries({ queryKey: ['observation-locations'] });
    },
  });

  if (sites.length <= 1) return null;

  return (
    <div>
      <ObservedFromDropdown
        isDark={isDark}
        isAdmin={isAdmin}
        sites={sites}
        currentSiteId={currentSite?.id ?? null}
        open={open}
        setOpen={setOpen}
        isPending={mutation.isPending}
        onSelect={(id) => { mutation.mutate(id); setOpen(false); }}
      />
      {mutation.isError && (
        <p className="mt-2 text-xs text-red-400">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to update site.'}
        </p>
      )}
    </div>
  );
}

function ObservedFromDropdown({
  isDark,
  isAdmin,
  sites,
  currentSiteId,
  open,
  setOpen,
  isPending,
  onSelect,
}: {
  isDark: boolean;
  isAdmin: boolean;
  sites: Array<{ id: string; name: string; isDefault: boolean }>;
  currentSiteId: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  isPending: boolean;
  onSelect: (siteId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wrapRef, () => setOpen(false), { closeOnEscape: true });

  const label = sites.find(s => s.id === currentSiteId)?.name ?? 'Default site';

  if (!isAdmin) {
    return <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{label}</p>;
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
          {sites.map(site => (
            <li key={site.id}>
              <button
                type="button"
                onClick={() => onSelect(site.id)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  site.id === currentSiteId
                    ? isDark ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-900'
                    : isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                {site.name}{site.isDefault ? ' (default)' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
