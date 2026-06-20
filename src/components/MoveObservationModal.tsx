import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Search, Loader2, AlertTriangle } from 'lucide-react';
import { moveObservation } from '../lib/api/library';
import { searchDsoCatalog, type DsoEntry } from '../lib/api/planner';
import { useTheme } from '../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  date: string;
  displayName: string;
  formattedDate: string;
}

export function MoveObservationModal({ isOpen, onClose, objectId, date, displayName, formattedDate }: Props) {
  const { isDark, isNight, isSpace } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [moveSearch, setMoveSearch] = useState('');
  const [moveSearchResults, setMoveSearchResults] = useState<DsoEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<DsoEntry | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  useEffect(() => {
    if (!isOpen) return;
    setMoveSearch('');
    setMoveSearchResults([]);
    setSelectedTarget(null);
    setMoveError('');
  }, [isOpen]);

  useEffect(() => {
    if (!moveSearch.trim() || moveSearch.trim().length < 2) {
      setMoveSearchResults([]);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchDsoCatalog(moveSearch.trim(), 10);
        if (!cancelled) setMoveSearchResults(data.results);
      } catch {
        if (!cancelled) setMoveSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [moveSearch]);

  const handleMove = useCallback(async () => {
    if (!selectedTarget || isMoving) return;
    setIsMoving(true);
    setMoveError('');
    try {
      await moveObservation(objectId, date, selectedTarget.id);
      onClose();
      await queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      await queryClient.invalidateQueries({ queryKey: ['observation-files', objectId, date] });
      await queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
      await queryClient.invalidateQueries({ queryKey: ['library-sessions', selectedTarget.id] });
      await queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      await queryClient.invalidateQueries({ queryKey: ['observations'] });
      await queryClient.invalidateQueries({ queryKey: ['processedImages', objectId, date] });
      await queryClient.invalidateQueries({ queryKey: ['processedImages', selectedTarget.id, date] });
      await queryClient.invalidateQueries({ queryKey: ['all-processed-images', objectId] });
      await queryClient.invalidateQueries({ queryKey: ['all-processed-images', selectedTarget.id] });
      navigate(`/observations/${encodeURIComponent(selectedTarget.id)}/${encodeURIComponent(date)}`);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Move failed');
      setIsMoving(false);
    }
  }, [selectedTarget, isMoving, objectId, date, onClose, queryClient, navigate]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`w-full max-w-md mx-4 rounded-2xl border p-6 space-y-4 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-xl'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
            <ArrowRightLeft className={`w-5 h-5 ${accentText}`} />
          </div>
          <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Move Observation
          </h3>
        </div>
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Move this observation from{' '}
          <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{displayName}</span>{' '}
          ({formattedDate}) to a different object. All files (JPGs, FITS, thumbnails) will be moved.
        </p>

        <div className="space-y-1.5">
          <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Search for target object
          </label>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
            <input
              type="text"
              value={moveSearch}
              onChange={e => { setMoveSearch(e.target.value); setSelectedTarget(null); }}
              placeholder="e.g. M42, NGC 7000, Orion Nebula"
              autoFocus
              className={`w-full pl-9 pr-3 py-2 rounded-lg border text-sm transition ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-accent-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
            {isSearching && (
              <Loader2 className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
            )}
          </div>
        </div>

        {moveSearchResults.length > 0 && (
          <div className={`max-h-48 overflow-y-auto rounded-lg border ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            {moveSearchResults.map(entry => (
              <button
                key={entry.id}
                onClick={() => setSelectedTarget(entry)}
                className={`w-full text-left px-3 py-2 text-sm transition flex items-center justify-between ${
                  selectedTarget?.id === entry.id
                    ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                    : isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                } ${isDark ? 'border-b border-slate-800 last:border-0' : 'border-b border-slate-100 last:border-0'}`}
              >
                <div>
                  <span className="font-medium">{entry.id}</span>
                  {entry.name && entry.name !== entry.id && (
                    <span className={`ml-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {entry.name}
                    </span>
                  )}
                </div>
                <div className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {entry.type && <span>{entry.type}</span>}
                  {entry.constellation && <span className="ml-2">{entry.constellation}</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {selectedTarget && (
          <div className={`rounded-lg p-3 text-sm ${isDark ? 'bg-accent-500/10 border border-accent-500/20' : 'bg-accent-50 border border-accent-100'}`}>
            <div className={`font-medium ${isDark ? 'text-accent-400' : 'text-accent-700'}`}>
              Moving to: {selectedTarget.id}{selectedTarget.name && selectedTarget.name !== selectedTarget.id ? ` - ${selectedTarget.name}` : ''}
            </div>
            <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {[selectedTarget.type, selectedTarget.constellation].filter(Boolean).join(' · ')}
            </div>
          </div>
        )}

        {moveError && (
          <div className="flex items-center gap-2 text-sm text-red-500">
            <AlertTriangle className="w-4 h-4" />
            {moveError}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={isMoving}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleMove}
            disabled={!selectedTarget || isMoving}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 ${
              isDark
                ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                : 'bg-accent-600 text-white hover:bg-accent-700'
            }`}
          >
            {isMoving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Move Observation
          </button>
        </div>
      </div>
    </div>
  );
}
