import { X } from 'lucide-react';
import { Modal } from './ui/Modal';
import { useTheme } from '../hooks/useTheme';
import { NewObservationForm, type NewObservationResult } from './observations/NewObservationForm';

/**
 * Modal presentation of the Log Observation form. Used from ObjectDetail so
 * adding an observation to an object stays in place instead of navigating to
 * the full `/observations/new` page. Shares all form logic with that page via
 * `NewObservationForm`.
 */
export function NewObservationModal({
  isOpen,
  onClose,
  objectId,
  objectName,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Locks the form to an existing object. Omit (library entry point) to let
   *  the user search for any object. */
  objectId?: string;
  objectName?: string;
  onSuccess: (result: NewObservationResult) => void;
}) {
  const { isDark } = useTheme();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Log Observation"
      className={`w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl border shadow-2xl ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between gap-4 px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div>
          <h2 className={`font-display text-lg font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Log Observation
          </h2>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Record a viewing session - optionally attach an image and notes.
          </p>
        </div>
        <button
          onClick={onClose}
          className={`shrink-0 p-1.5 rounded-lg transition ${
            isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
          }`}
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="px-6 py-5 overflow-y-auto">
        <NewObservationForm
          prefilledObjectId={objectId}
          prefilledObjectName={objectName}
          onSuccess={onSuccess}
          onCancel={onClose}
        />
      </div>
    </Modal>
  );
}
