import { useState } from 'react';
import { ConfirmModal } from './ConfirmModal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Moon, Eye, Star, MapPin, Save, RotateCw, Trash2, X } from 'lucide-react';
import { getNote, saveNote, deleteNote as deleteNoteApi } from '../lib/api/notes';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface SessionNotesModalProps {
  objectId: string;
  date: string;
  onClose: () => void;
}

interface FormState {
  bortleClass: number | null;
  seeingRating: number | null;
  transparencyRating: number | null;
  equipment: string;
  notes: string;
  rating: number | null;
  location: string;
}

const EMPTY_FORM: FormState = {
  bortleClass: null,
  seeingRating: null,
  transparencyRating: null,
  equipment: '',
  notes: '',
  rating: null,
  location: '',
};

export function SessionNotesModal({ objectId, date, onClose }: SessionNotesModalProps) {
  const { isDark } = useTheme();
  const { isViewer } = useAuth();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: existingNote } = useQuery({
    queryKey: ['note', objectId, date],
    queryFn: () => getNote(objectId, date),
  });

  const initialForm: FormState = existingNote
    ? {
        bortleClass: existingNote.bortleClass,
        seeingRating: existingNote.seeingRating,
        transparencyRating: existingNote.transparencyRating,
        equipment: existingNote.equipment || '',
        notes: existingNote.notes || '',
        rating: existingNote.rating,
        location: existingNote.location || '',
      }
    : EMPTY_FORM;

  const [form, setForm] = useState<FormState>(initialForm);
  const [formKey, setFormKey] = useState(existingNote?.id ?? '');
  if ((existingNote?.id ?? '') !== formKey) {
    setFormKey(existingNote?.id ?? '');
    setForm(initialForm);
  }

  const saveMutation = useMutation({
    mutationFn: () => saveNote({ objectId, date, ...form }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note', objectId, date] });
      onClose();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!existingNote?.id) throw new Error('No note to delete');
      return deleteNoteApi(existingNote.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note', objectId, date] });
      onClose();
    },
  });

  const isDirty =
    form.bortleClass !== initialForm.bortleClass ||
    form.seeingRating !== initialForm.seeingRating ||
    form.transparencyRating !== initialForm.transparencyRating ||
    form.equipment !== initialForm.equipment ||
    form.notes !== initialForm.notes ||
    form.rating !== initialForm.rating ||
    form.location !== initialForm.location;
  const canSave = isDirty && !saveMutation.isPending && !isViewer;

  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = () => {
    if (isDirty && !saveMutation.isPending && !deleteMutation.isPending) {
      setConfirmingClose(true);
    } else {
      onClose();
    }
  };

  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-200 placeholder-slate-400'
  }`;

  return (
    <>
      <Modal
        isOpen
        onClose={requestClose}
        title="Session Notes"
        className={`relative rounded-2xl border shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto ${
          isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
        }`}
      >
          {/* Header */}
          <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="flex items-center gap-3">
              <NotebookPen className={`w-5 h-5 ${existingNote ? 'text-amber-500' : isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <h2 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Session Notes
              </h2>
              {existingNote && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">Saved</span>
              )}
              {isViewer && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>View only</span>
              )}
            </div>
            <button
              onClick={requestClose}
              aria-label="Close"
              className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-4">
            {/* Moon info (auto-calculated) */}
            {existingNote?.moonPhase && (
              <div className={`flex items-center gap-4 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span className="flex items-center gap-1.5">
                  <Moon className="w-4 h-4" />
                  {existingNote.moonPhase}
                </span>
                {existingNote.moonIllumination !== null && (
                  <span>{existingNote.moonIllumination}% illuminated</span>
                )}
              </div>
            )}

            {/* Rating row */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <Star className="w-3 h-3 inline mr-1" />Personal Rating
                </label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      onClick={() => setForm(f => ({ ...f, rating: f.rating === n ? null : n }))}
                      disabled={isViewer}
                      className={`flex-1 min-w-0 h-11 rounded text-xs font-medium transition disabled:cursor-default ${
                        form.rating && form.rating >= n
                          ? 'bg-accent-500 text-white'
                          : isDark ? 'bg-slate-800 text-slate-500 hover:bg-slate-700 disabled:hover:bg-slate-800' : 'bg-slate-100 text-slate-400 hover:bg-slate-200 disabled:hover:bg-slate-100'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <Eye className="w-3 h-3 inline mr-1" />Seeing
                </label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      onClick={() => setForm(f => ({ ...f, seeingRating: f.seeingRating === n ? null : n }))}
                      disabled={isViewer}
                      className={`flex-1 min-w-0 h-11 rounded text-xs font-medium transition disabled:cursor-default ${
                        form.seeingRating && form.seeingRating >= n
                          ? 'bg-teal-500 text-white'
                          : isDark ? 'bg-slate-800 text-slate-500 hover:bg-slate-700 disabled:hover:bg-slate-800' : 'bg-slate-100 text-slate-400 hover:bg-slate-200 disabled:hover:bg-slate-100'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Bortle Class
                </label>
                <select
                  value={form.bortleClass ?? ''}
                  onChange={e => setForm(f => ({ ...f, bortleClass: e.target.value ? parseInt(e.target.value) : null }))}
                  disabled={isViewer}
                  className={inputClass}
                >
                  <option value="">-</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                    <option key={n} value={n}>Bortle {n}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Location + Equipment */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <MapPin className="w-3 h-3 inline mr-1" />Location
                </label>
                <input
                  type="text"
                  placeholder="Backyard, dark site, etc."
                  value={form.location}
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                  readOnly={isViewer}
                  className={`${inputClass} ${isViewer ? 'cursor-default' : ''}`}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Equipment
                </label>
                <input
                  type="text"
                  placeholder="SeeStar S50, LP filter, etc."
                  value={form.equipment}
                  onChange={e => setForm(f => ({ ...f, equipment: e.target.value }))}
                  readOnly={isViewer}
                  className={`${inputClass} ${isViewer ? 'cursor-default' : ''}`}
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Notes
              </label>
              <textarea
                placeholder="Observing conditions, weather, what went well..."
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                readOnly={isViewer}
                rows={4}
                className={`${inputClass} ${isViewer ? 'cursor-default' : ''}`}
              />
            </div>
          </div>

          {/* Footer */}
          {!isViewer && (
            <div className={`flex justify-between items-center p-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              {existingNote ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-danger-500 hover:bg-danger-500/10 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Note
                </button>
              ) : <span />}
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!canSave}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  canSave
                    ? 'bg-accent-500 text-white hover:bg-accent-600'
                    : isDark
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
              >
                {saveMutation.isPending ? (
                  <RotateCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save Notes
              </button>
            </div>
          )}
          {confirmingClose && (
            <CloseConfirm
              message="Discard unsaved notes?"
              onCancel={() => setConfirmingClose(false)}
              onDiscard={() => { setConfirmingClose(false); onClose(); }}
            />
          )}
      </Modal>

      {confirmDelete && (
        <ConfirmModal
          title="Delete session notes?"
          message="This will permanently delete all notes for this session. This cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            deleteMutation.mutate();
          }}
        />
      )}
    </>
  );
}
