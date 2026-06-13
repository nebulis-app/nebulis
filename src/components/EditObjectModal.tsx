import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import {
  getCatalogObjectInfo,
  saveCatalogOverride,
  deleteCatalogOverride,
  type CatalogOverrideInput,
  type CatalogOverrideRecord,
} from '../lib/api/catalog';
import { Modal } from './ui/Modal';
import { CloseConfirm } from './ui/CloseConfirm';

interface EditObjectModalProps {
  objectId: string;
  /** Currently displayed values, used as placeholders when the override is empty. */
  current: {
    name?: string;
    type?: string;
    constellation?: string;
    magnitude?: number | null;
    description?: string;
    ra?: string | number | null;
    dec?: string | number | null;
    distanceLy?: number | null;
  };
  onClose: () => void;
}

/** Form state — strings everywhere so the inputs control cleanly. */
interface FormState {
  name: string;
  type: string;
  constellation: string;
  magnitude: string;
  description: string;
  ra: string;
  dec: string;
  distanceLy: string;
}

function initialState(override: CatalogOverrideRecord | null): FormState {
  return {
    name: override?.name ?? '',
    type: override?.type ?? '',
    constellation: override?.constellation ?? '',
    magnitude: override?.magnitude != null ? String(override.magnitude) : '',
    description: override?.description ?? '',
    ra: override?.ra ?? '',
    dec: override?.dec ?? '',
    distanceLy: override?.distanceLy != null ? String(override.distanceLy) : '',
  };
}

function placeholder(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  return String(value);
}

export function EditObjectModal({ objectId, current, onClose }: EditObjectModalProps) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(null));
  const [error, setError] = useState<string | null>(null);

  // Fetch the existing override row so the inputs pre-fill with what the user
  // previously typed. /info already exposes this on its response, so no
  // dedicated endpoint is needed.
  const { data: info } = useQuery({
    queryKey: ['catalog-info', objectId],
    queryFn: () => getCatalogObjectInfo(objectId),
  });
  const override: CatalogOverrideRecord | null = info?.override ?? null;

  // When the override loads, seed the form once. Subsequent edits by the user
  // shouldn't be clobbered by background refetches.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (info && !seeded) {
      setForm(initialState(info.override ?? null));
      setSeeded(true);
    }
  }, [info, seeded]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['catalog', objectId] });
    queryClient.invalidateQueries({ queryKey: ['catalog-info', objectId] });
  };

  const save = useMutation({
    mutationFn: (patch: CatalogOverrideInput) => saveCatalogOverride(objectId, patch),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  const clear = useMutation({
    mutationFn: () => deleteCatalogOverride(objectId),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Build the patch. Empty strings become undefined so the server can clear
    // those fields. Numeric fields go through Number() and are rejected if
    // they don't parse — silently dropping a typo would be worse than telling
    // the user.
    const patch: CatalogOverrideInput = {
      name: form.name.trim() || undefined,
      type: form.type.trim() || undefined,
      constellation: form.constellation.trim() || undefined,
      description: form.description.trim() || undefined,
      ra: form.ra.trim() || undefined,
      dec: form.dec.trim() || undefined,
    };
    if (form.magnitude.trim()) {
      const n = Number(form.magnitude);
      if (!Number.isFinite(n)) { setError('Magnitude must be a number.'); return; }
      patch.magnitude = n;
    }
    if (form.distanceLy.trim()) {
      const n = Number(form.distanceLy);
      if (!Number.isFinite(n)) { setError('Distance must be a number.'); return; }
      patch.distanceLy = n;
    }
    save.mutate(patch);
  }

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm outline-none transition border ${
    isDark
      ? 'bg-slate-950 border-slate-700 text-slate-100 placeholder-slate-600 focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/20'
      : 'bg-white border-slate-200 text-slate-900 placeholder-slate-400 focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/20'
  }`;
  const labelClass = `block text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`;
  const busy = save.isPending || clear.isPending;

  // Dirty when the seeded form has diverged from any field. Once seeding has
  // finished (or there is no override row), we compare against the original
  // values to decide whether close should confirm.
  const baseline = initialState(override);
  const isDirty = seeded && (
    form.name !== baseline.name ||
    form.type !== baseline.type ||
    form.constellation !== baseline.constellation ||
    form.magnitude !== baseline.magnitude ||
    form.description !== baseline.description ||
    form.ra !== baseline.ra ||
    form.dec !== baseline.dec ||
    form.distanceLy !== baseline.distanceLy
  );

  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (isDirty) setConfirmingClose(true);
    else onClose();
  };

  return (
    <Modal
      isOpen
      onClose={requestClose}
      title={`Edit ${objectId}`}
      className="relative w-full max-w-2xl mx-4 max-h-[90vh]"
    >
      <form
        onSubmit={onSubmit}
        className={`rounded-2xl border w-full shadow-2xl max-h-[90vh] overflow-y-auto ${
          isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
        }`}
      >
        <div className={`px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
          <h2 className={`font-display text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            Edit {objectId}
          </h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            Your edits override catalog data for this object only. Leave a field blank to use the catalog value.
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={labelClass}>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder={placeholder(current.name)}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Type</label>
              <input
                type="text"
                value={form.type}
                onChange={e => set('type', e.target.value)}
                placeholder={placeholder(current.type)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Constellation</label>
              <input
                type="text"
                value={form.constellation}
                onChange={e => set('constellation', e.target.value)}
                placeholder={placeholder(current.constellation)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Description</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder={current.description ? current.description.slice(0, 120) : ''}
              rows={4}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Magnitude</label>
              <input
                type="text"
                inputMode="decimal"
                value={form.magnitude}
                onChange={e => set('magnitude', e.target.value)}
                placeholder={placeholder(current.magnitude)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Distance (light-years)</label>
              <input
                type="text"
                inputMode="numeric"
                value={form.distanceLy}
                onChange={e => set('distanceLy', e.target.value)}
                placeholder={placeholder(current.distanceLy)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>RA</label>
              <input
                type="text"
                value={form.ra}
                onChange={e => set('ra', e.target.value)}
                placeholder={placeholder(current.ra)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Dec</label>
              <input
                type="text"
                value={form.dec}
                onChange={e => set('dec', e.target.value)}
                placeholder={placeholder(current.dec)}
                className={inputClass}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-rose-500">{error}</p>
          )}
        </div>

        <div className={`px-6 py-4 flex items-center justify-between gap-3 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}>
          <button
            type="button"
            onClick={() => clear.mutate()}
            disabled={!override || busy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
              override
                ? isDark ? 'text-rose-400 hover:bg-rose-500/10' : 'text-rose-600 hover:bg-rose-50'
                : isDark ? 'text-slate-600 cursor-not-allowed' : 'text-slate-400 cursor-not-allowed'
            }`}
          >
            <RotateCcw className="w-4 h-4" />
            Clear overrides
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={requestClose}
              disabled={busy}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 min-w-[5rem] px-4 py-2 rounded-xl text-sm font-semibold bg-accent-500 text-white hover:bg-accent-600 active:scale-[0.99] transition disabled:opacity-60"
            >
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </button>
          </div>
        </div>
      </form>
      {confirmingClose && (
        <CloseConfirm
          message="Discard unsaved edits?"
          onCancel={() => setConfirmingClose(false)}
          onDiscard={() => { setConfirmingClose(false); onClose(); }}
        />
      )}
    </Modal>
  );
}
