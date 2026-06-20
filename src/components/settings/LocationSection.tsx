import { useEffect, useRef, useState } from 'react';
import {
  MapPin,
  CheckCircle2,
  AlertCircle,
  Search,
  Loader2,
  X,
} from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { fetchLocationInfo, searchLocations, type GeocodeSearchResult } from '../../lib/api/catalog';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getInputClass, getLabelClass, getHelperClass, getCardClass } from './SettingsUI';

export function LocationSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [detectStatus, setDetectStatus] = useState<'idle' | 'detecting' | 'success' | 'error'>('idle');
  const [detectError, setDetectError] = useState('');

  // The in-progress search text. `null` means "not typing" — show the saved
  // location name so it persists across visits until the user clears it.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);

  const hasLocation =
    (form.latitude != null && form.longitude != null) ||
    Boolean(form.locationName && form.locationName.trim());

  function clearLocation() {
    setForm(f => ({ ...f, locationName: '', latitude: null, longitude: null }));
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
        const locationInfo = await fetchLocationInfo(lat, lon);
        setForm(f => ({
          ...f,
          latitude: lat,
          longitude: lon,
          ...(locationInfo.city ? { locationName: locationInfo.city } : {}),
          ...(locationInfo.timezone ? { timezone: locationInfo.timezone } : {}),
        }));
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

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 mb-5">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
          <MapPin className="w-5 h-5 text-teal-500" />
        </div>
        <div>
          <h2 className={`font-display text-[17px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Location &amp; Sky
          </h2>
          <p className={`text-[13px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Required for the Target Planner to calculate visibility
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Coordinates */}
        <div className={`${getCardClass(isDark)} space-y-5`}>
          {/* City / place search */}
          <LocationSearch
            isDark={isDark}
            form={form}
            setForm={setForm}
            query={searchQuery}
            setQuery={setSearchQuery}
            onClear={clearLocation}
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
                value={form.latitude ?? ''}
                onChange={e =>
                  setForm(f => ({
                    ...f,
                    latitude: e.target.value === '' ? null : parseFloat(e.target.value),
                  }))
                }
              />
              <p className={helperClass}>Decimal degrees, north positive</p>
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
                value={form.longitude ?? ''}
                onChange={e =>
                  setForm(f => ({
                    ...f,
                    longitude: e.target.value === '' ? null : parseFloat(e.target.value),
                  }))
                }
              />
              <p className={helperClass}>Decimal degrees, east positive</p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={detectLocation}
              disabled={detectStatus === 'detecting'}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all duration-150 ${
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
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all duration-150 ${
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <X className="w-4 h-4" />
                Clear location
              </button>
            )}
            {detectStatus === 'success' && (
              <span className="text-sm text-emerald-500 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Location detected
              </span>
            )}
            {detectStatus === 'error' && (
              <span className="text-sm text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> {detectError}
              </span>
            )}
          </div>
        </div>


      </div>
    </div>
  );
}

// ─── City / place autocomplete ──────────────────────────────────────────────
// Debounced forward-geocode against Open-Meteo (via /catalog/geocode/search).
// Selecting a result fills latitude, longitude, locationName, and timezone.
// The box shows the saved locationName until the user types or clears it.

function LocationSearch({
  isDark,
  form,
  setForm,
  query,
  setQuery,
  onClear,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
  query: string | null;
  setQuery: (v: string | null) => void;
  onClear: () => void;
}) {
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [results, setResults] = useState<GeocodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Monotonic request id so a slow earlier response can't overwrite a newer one.
  const requestIdRef = useRef(0);

  useClickOutside(wrapRef, () => setOpen(false), { closeOnEscape: true });

  // `query === null` means the box is showing the saved name, not a live search.
  const displayValue = query ?? (form.locationName ?? '');

  useEffect(() => {
    const q = (query ?? '').trim();
    // Bump the request id (a ref, not state) so any in-flight response from a
    // previous keystroke is ignored when it resolves.
    const id = ++requestIdRef.current;
    // All state updates happen inside the timer callback (asynchronously), never
    // synchronously in the effect body. Short queries reset on a 0ms tick.
    const handle = setTimeout(async () => {
      if (q.length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const found = await searchLocations(q);
      if (id !== requestIdRef.current) return; // superseded by a newer keystroke
      setResults(found);
      setActiveIndex(found.length > 0 ? 0 : -1);
      setLoading(false);
      setOpen(true);
    }, q.length < 2 ? 0 : 300);
    return () => clearTimeout(handle);
  }, [query]);

  function select(r: GeocodeSearchResult) {
    setForm(f => ({
      ...f,
      latitude: Math.round(r.latitude * 10000) / 10000,
      longitude: Math.round(r.longitude * 10000) / 10000,
      locationName: r.label,
      ...(r.timezone ? { timezone: r.timezone } : {}),
    }));
    setQuery(null); // fall back to showing the saved name (now r.label)
    setOpen(false);
    setResults([]);
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
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
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
                  i === activeIndex
                    ? isDark ? 'bg-slate-800' : 'bg-slate-100'
                    : ''
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
