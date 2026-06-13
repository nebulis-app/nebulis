import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { deleteLibrarySession } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  date: string;
  displayName: string;
  formattedDate: string;
}

export function DeleteSessionModal({ isOpen, onClose, objectId, date, displayName, formattedDate }: Props) {
  const { isDark } = useTheme();
  const navigate = useNavigate();

  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (confirmText.toLowerCase() !== 'delete') return;
    setIsDeleting(true);
    try {
      await deleteLibrarySession(objectId, date);
      onClose();
      navigate(-1);
    } catch {
      setIsDeleting(false);
    }
  }, [confirmText, objectId, date, onClose, navigate]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`w-full max-w-md mx-4 rounded-2xl border p-6 space-y-4 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-xl'}`}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-red-500/10">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Delete Observation
          </h3>
        </div>
        <div className={`text-sm space-y-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <p>
            You are about to delete{' '}
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>only this observation</span>{' '}
            of{' '}
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{displayName}</span>{' '}
            from{' '}
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{formattedDate}</span>.
          </p>
          <p>
            All files from this session will be permanently removed and this observation will not be re-imported from the telescope.
          </p>
          <p>Other observations of this object are not affected.</p>
        </div>
        <div className="space-y-1.5">
          <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Type <span className="font-bold text-red-500">delete</span> to confirm
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleDelete(); }}
            placeholder="delete"
            autoFocus
            className={`w-full px-3 py-2 rounded-lg border text-sm transition ${
              isDark
                ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-red-500'
                : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-red-500'
            } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500`}
          />
        </div>
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={confirmText.toLowerCase() !== 'delete' || isDeleting}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white transition hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Delete Observation
          </button>
        </div>
      </div>
    </div>
  );
}
