import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Search, Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { createSite, updateSite, type ObservingSite, type ObservingSiteInput } from '../../lib/api/sites';
import { fetchLocationInfo, searchLocations, type GeocodeSearchResult } from '../../lib/api/catalog';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getInputClass, getLabelClass, getHelperClass } from './SettingsUI';
import { Modal } from '../ui/Modal';

/**
 * Create/edit modal for a single observing site: name, coordinates
 * (searchable by place name or detected from the browser), timezone, and
 * minimum altitude. Pass `existing` to edit; omit to create.
 *
 * Horizon profile and the visible-sky mask are not edited here — the mask
 * editor already lives in the Planner (Set Visible Sky) and now targets
 * whichever site is active there, so this modal doesn't duplicate it.
 */
export function SiteEditorModal({
  isDark,
  existing,
  onClose,
}: {
  isDark: boolean;
  existing?: ObservingSite;
  onClose: (savedId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [name, setName] = useState(existing?.name ?? '');
  const [latitude, setLatitude] = useState<number | null>(existing?.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(existing?.longitude ?? null);
  const [timezone, setTimezone] = useState(existing?.timezone ?? '');
  const [minAlt, setMinAlt] = useState(existing?.minAlt ?? 20);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [detectStatus, setDetectStatus] = useState<'idle' | 'detecting' | 'success' | 'error'>('idle');
  const [detectError, setDetectError] = useState('');

  const hasLocation = latitude != null && longitude != null;

  function clearLocation() {
    setLatitude(null);
    setLongitude(null);
    setSearchQuery(null);
    setDetectStatus('idle');
    setDetectError('');
  }

  function detectLocation() {
    if (!navigator.geolocation) {
      setDetectStatus('error');
      setDetectError('Geolocation is not supported by this browser.');
      return;
    }
    setDetectStatus('detecting');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        const info = await fetchLocationInfo(lat, lon);
        setLatitude(lat);
        setLongitude(lon);
        if (info.city && !name.trim()) setName(info.city);
        if (info.timezone) setTimezone(info.timezone);
        setDetectStatus('success');
      },
      (err) => {
        setDetectStatus('error');
        setDetectError(
          err.code === 1
            ? 'Location access denied - allow it in your browser and try again.'
            : err.code === 2
              ? 'Location unavailable. Try entering coordinates manually.'
              : 'Location request timed out.',
        );
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  }

  const mutation = useMutation({
    mutationFn: () => {
      const data: ObservingSiteInput = {
        name: name.trim() || undefined,
        latitude,
        longitude,
        timezone,
        minAlt,
      };
      return isEdit ? updateSite(existing.id, data) : createSite(data);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      onClose(saved.id);
    },
    retry: false,
  });

  return (
    <Modal
      isOpen
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title={isEdit ? 'Edit observing site' : 'Add observing site'}
      className={`w-full max-w-md rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}
    >
        <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
              <MapPin className="w-4 h-4 text-teal-500" />
            </div>
            <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {isEdit ? 'Edit Observing Site' : 'Add Observing Site'}
            </h3>
          </div>
          <button
            onClick={() => onClose()}
            className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {mutation.error && (
            <div className={`p-3 rounded-lg border text-sm ${isDark ? 'bg-red-950/30 border-red-900/50 text-red-200' : 'bg-red-50 border-red-200 text-red-800'}`}>
              {mutation.error instanceof Error ? mutation.error.message : 'Failed to save site.'}
            </div>
          )}
          <div>
            <label className={labelClass}>Name</label>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. Backyard, Dark Sky Site"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <SiteLocationSearch
            isDark={isDark}
            savedName={name}
            query={searchQuery}
            setQuery={setSearchQuery}
            onClear={clearLocation}
            onSelect={(r) => {
              setLatitude(Math.round(r.latitude * 10000) / 10000);
              setLongitude(Math.round(r.longitude * 10000) / 10000);
              if (!name.trim()) setName(r.label);
              if (r.timezone) setTimezone(r.timezone);
            }}
          />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Latitude</label>
              <input
                type="number"
                step="0.0001"
                min="-90"
                max="90"
                placeholder="e.g. 40.7128"
                className={inputClass}
                value={latitude ?? ''}
                onChange={e => setLatitude(e.target.value === '' ? null : parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className={labelClass}>Longitude</label>
              <input
                type="number"
                step="0.0001"
                min="-180"
                max="180"
                placeholder="e.g. -74.0060"
                className={inputClass}
                value={longitude ?? ''}
                onChange={e => setLongitude(e.target.value === '' ? null : parseFloat(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={detectLocation}
              disabled={detectStatus === 'detecting'}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border transition ${
                isDark
                  ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              <MapPin className="w-4 h-4" />
              {detectStatus === 'detecting' ? 'Detecting…' : 'Use current location'}
            </button>
            {hasLocation && (
              <button
                type="button"
                onClick={clearLocation}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border transition ${
                  isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <X className="w-4 h-4" />
                Clear
              </button>
            )}
            {detectStatus === 'success' && (
              <span className="text-sm text-emerald-500 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Detected</span>
            )}
            {detectStatus === 'error' && (
              <span className="text-sm text-red-400 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> {detectError}</span>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelClass}>Minimum altitude</label>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{minAlt}°</span>
            </div>
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={minAlt}
              onChange={e => setMinAlt(parseInt(e.target.value, 10))}
              className="w-full accent-accent-500"
            />
            <p className={helperClass}>The Planner hides targets below this altitude for this site.</p>
          </div>
        </div>

        <div className={`flex items-center justify-end gap-3 px-5 pb-5`}>
          <button
            type="button"
            onClick={() => onClose()}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Add site'}
          </button>
        </div>
    </Modal>
  );
}

// ─── City / place autocomplete, scoped to this modal's local state ────────────

function SiteLocationSearch({
  isDark,
  savedName,
  query,
  setQuery,
  onClear,
  onSelect,
}: {
  isDark: boolean;
  savedName: string;
  query: string | null;
  setQuery: (v: string | null) => void;
  onClear: () => void;
  onSelect: (r: GeocodeSearchResult) => void;
}) {
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(wrapRef, () => setOpen(false), { closeOnEscape: true });

  const displayValue = query ?? savedName;

  // useQuery owns fetching, debounced-key deduplication, and (via the keyed
  // cache) cancellation of superseded requests — no requestIdRef / cancelled
  // flag, and no write-after-unmount, because it never sets component state.
  const searchQuery = useQuery({
    queryKey: ['location-search', debouncedQuery],
    queryFn: () => searchLocations(debouncedQuery),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
  const results: GeocodeSearchResult[] = searchQuery.data ?? [];
  const loading = searchQuery.isFetching;

  // Debounce the input into the query key. Selecting a result sets `query` to
  // the picked label but leaves `debouncedQuery` alone, so it never searches
  // for its own label (what the old skipNextSearchRef flag was for).
  const scheduleSearch = (raw: string) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const q = raw.trim();
    if (q.length < 2) { setDebouncedQuery(''); return; }
    debounceTimer.current = setTimeout(() => setDebouncedQuery(q), 300);
  };

  // Reset the keyboard cursor to the first row whenever a fresh result set
  // arrives (render-phase adjustment keyed on the fetch timestamp).
  const [seenUpdate, setSeenUpdate] = useState(0);
  if (searchQuery.dataUpdatedAt !== seenUpdate && searchQuery.dataUpdatedAt !== 0) {
    setSeenUpdate(searchQuery.dataUpdatedAt);
    setActiveIndex(results.length > 0 ? 0 : -1);
    if (results.length > 0) setOpen(true);
  }

  function select(r: GeocodeSearchResult) {
    onSelect(r);
    setQuery(r.label);
    setDebouncedQuery('');
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[activeIndex] ?? results[0];
      if (pick) select(pick);
    }
  }

  const showDropdown = open && (query ?? '').trim().length >= 2;

  return (
    <div className="relative" ref={wrapRef}>
      <label className={labelClass}>Search for a place</label>
      <div className="relative">
        <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        <input
          type="text"
          autoComplete="off"
          placeholder="City, state, country…"
          className={`${getInputClass(isDark)} pl-9 pr-9`}
          value={displayValue}
          onChange={e => { setQuery(e.target.value); setOpen(true); scheduleSearch(e.target.value); }}
          onFocus={e => { e.currentTarget.select(); if (results.length > 0) setOpen(true); }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
        />
        {loading ? (
          <Loader2 className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        ) : displayValue ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear location"
            title="Clear location"
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors ${
              isDark ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-700' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        ) : null}
      </div>
      <p className={helperClass}>Type a city to auto-fill coordinates and timezone</p>

      {showDropdown && (
        <ul
          role="listbox"
          className={`absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-auto rounded-xl border shadow-lg ${
            isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
          }`}
        >
          {!loading && results.length === 0 && (
            <li className={`px-3 py-2.5 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              No matches found
            </li>
          )}
          {results.map((r, i) => (
            <li key={`${r.label}-${r.latitude}-${r.longitude}`} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onMouseDown={e => { e.preventDefault(); select(r); }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
                  i === activeIndex ? (isDark ? 'bg-slate-800' : 'bg-slate-100') : ''
                }`}
              >
                <MapPin className={`w-4 h-4 shrink-0 ${isDark ? 'text-teal-400' : 'text-teal-500'}`} />
                <span className="min-w-0">
                  <span className={`block text-sm font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                    {r.name}
                  </span>
                  <span className={`block text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {[r.admin1, r.country].filter(Boolean).join(', ')}
                    {r.timezone ? ` · ${r.timezone}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
