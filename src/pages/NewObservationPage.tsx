import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ArrowLeft, Search, CalendarDays, ImagePlus, StickyNote, Loader2, X, Upload, CheckCircle2 } from 'lucide-react';
import { searchDsoCatalog, type DsoEntry } from '../lib/api/planner';
import { createManualObservation } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';

export function NewObservationPage() {
  const { isDark } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Pre-fill from query params (e.g. coming from ObjectDetail)
  const prefilledObjectId = searchParams.get('objectId') || '';
  const prefilledObjectName = searchParams.get('objectName') || '';

  const [objectQuery, setObjectQuery] = useState(prefilledObjectName || prefilledObjectId);
  const [selectedObject, setSelectedObject] = useState<DsoEntry | null>(null);
  const [manualObjectName, setManualObjectName] = useState(prefilledObjectName || prefilledObjectId);
  const [showDropdown, setShowDropdown] = useState(false);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounced search query for React Query
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // True when navigating from an existing object (object is locked)
  const isObjectLocked = !!(prefilledObjectId || prefilledObjectName);
  const effectiveObjectName = selectedObject?.id || manualObjectName;

  // React Query for DSO search
  const { data: searchData, isFetching: isSearching } = useQuery({
    queryKey: ['dso-search', debouncedQuery],
    queryFn: () => searchDsoCatalog(debouncedQuery, 12),
    enabled: debouncedQuery.trim().length > 0,
    staleTime: 30_000,
  });
  const searchResults = searchData?.results ?? [];

  const handleObjectSearch = (q: string) => {
    setObjectQuery(q);
    setManualObjectName(q);
    setSelectedObject(null);

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!q.trim()) {
      setDebouncedQuery('');
      setShowDropdown(false);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedQuery(q);
      setShowDropdown(true);
    }, 250);
  };

  // Clean up timeout on unmount
  useEffect(() => () => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
  }, []);

  const selectObject = (entry: DsoEntry) => {
    setSelectedObject(entry);
    setObjectQuery(entry.name !== entry.id ? `${entry.id} - ${entry.name}` : entry.id);
    setManualObjectName(entry.id);
    setShowDropdown(false);
  };

  const setImageFile = (file: File) => {
    setImage(file);
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (typeof result === 'string') setImagePreview(result);
    };
    reader.readAsDataURL(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setImageFile(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) setImageFile(file);
  }, []);

  const submitMutation = useMutation({
    mutationFn: (params: { objectName: string; date: string; notes?: string; image: File | null }) =>
      createManualObservation(params),
    onSuccess: (result) => {
      navigate(`/observations/${encodeURIComponent(result.objectId)}/${encodeURIComponent(result.date)}`);
    },
  });

  const handleSubmit = () => {
    const objName = effectiveObjectName.trim();
    if (!objName) { submitMutation.reset(); return; }
    if (!date) { submitMutation.reset(); return; }
    submitMutation.mutate({ objectName: objName, date, notes: notes.trim() || undefined, image });
  };

  const cardBg = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const inputBase = `w-full px-4 py-3 rounded-xl border text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark
      ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-500 focus:border-accent-500/50'
      : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-accent-400'
  }`;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <Link
        to={prefilledObjectId ? `/object/${encodeURIComponent(prefilledObjectId)}` : '/'}
        className={`inline-flex items-center gap-2 text-sm font-medium transition ${
          isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'
        }`}
      >
        <ArrowLeft className="w-4 h-4" />
        {prefilledObjectId ? `Back to ${prefilledObjectName || prefilledObjectId}` : 'Back to Library'}
      </Link>

      {/* Page header */}
      <div>
        <h1 className={`font-display text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Log Observation
        </h1>
        <p className={`mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Record a viewing session - optionally attach an image and notes.
        </p>
      </div>

      <div className={`rounded-2xl border p-6 space-y-6 ${cardBg}`}>

        {/* Object selector */}
        <div className="space-y-2">
          <label className={`flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            <Search className="w-4 h-4 text-accent-500" />
            Object
          </label>
          <div className="relative">
            <input
              type="text"
              placeholder="Search - try 'M42', 'Andromeda', 'Crab Nebula'…"
              value={objectQuery}
              onChange={e => handleObjectSearch(e.target.value)}
              onFocus={() => { if (searchResults.length > 0) setShowDropdown(true); }}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              disabled={isObjectLocked}
              className={`${inputBase} ${isObjectLocked ? 'opacity-70 cursor-default' : ''}`}
            />
            {isSearching && (
              <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-accent-500" />
            )}

            {showDropdown && searchResults.length > 0 && (
              <div className={`absolute z-50 mt-1 w-full rounded-xl border shadow-lg overflow-hidden ${
                isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200 shadow-slate-200/80'
              }`}>
                {searchResults.map(entry => (
                  <button
                    key={entry.id}
                    onMouseDown={() => selectObject(entry)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
                      isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={`font-medium text-sm ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                        {entry.id}
                        {entry.name !== entry.id && (
                          <span className={`ml-2 font-normal ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {entry.name}
                          </span>
                        )}
                      </div>
                      <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {entry.type}{entry.constellation ? ` · ${entry.constellation}` : ''}{entry.magnitude != null ? ` · Mag ${entry.magnitude}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {isObjectLocked && (
            <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Object inherited from existing entry - changing it will create a new entry.
            </p>
          )}
        </div>

        {/* Date */}
        <div className="space-y-2">
          <label className={`flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            <CalendarDays className="w-4 h-4 text-teal-500" />
            Observation Date
          </label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            max={today}
            className={inputBase}
          />
        </div>

        {/* Image upload */}
        <div className="space-y-2">
          <label className={`flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            <ImagePlus className="w-4 h-4 text-violet-500" />
            Image
            <span className={`ml-1 font-normal text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>(optional)</span>
          </label>

          {imagePreview ? (
            <div className="relative group">
              <img
                src={imagePreview}
                alt="Preview"
                className="w-full max-h-72 object-contain rounded-xl border border-slate-700"
              />
              <button
                onClick={() => { setImage(null); setImagePreview(null); }}
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white max-md:opacity-100 opacity-0 group-hover:opacity-100 transition"
                title="Remove image"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 h-40 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
                isDragging
                  ? isDark ? 'border-accent-500 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
                  : isDark ? 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Upload className={`w-8 h-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <p className={`text-sm text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                Drop an image here, or <span className="text-accent-500 font-medium">browse</span>
                <br />
                <span className="text-xs">JPG, PNG supported</span>
              </p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Notes */}
        <div className="space-y-2">
          <label className={`flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            <StickyNote className="w-4 h-4 text-amber-500" />
            Notes
            <span className={`ml-1 font-normal text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Conditions, equipment, impressions…"
            rows={4}
            className={`${inputBase} resize-y`}
          />
        </div>

        {/* Error */}
        {submitMutation.isError && (
          <div className="px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
            {submitMutation.error instanceof Error ? submitMutation.error.message : 'Failed to create observation'}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={submitMutation.isPending || !effectiveObjectName.trim() || !date}
          className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all ${
            submitMutation.isPending || !effectiveObjectName.trim() || !date
              ? isDark ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-accent-500 hover:bg-accent-600 text-white shadow-lg shadow-accent-500/20'
          }`}
        >
          {submitMutation.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
          ) : (
            <><CheckCircle2 className="w-4 h-4" /> Save Observation</>
          )}
        </button>
      </div>
    </div>
  );
}
