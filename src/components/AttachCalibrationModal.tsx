/**
 * Picks an object (and, optionally, one of its session dates) to attach a
 * flat/flat-dark calibration bundle to — see calibrationAttachments.ts for
 * why only these two types need this at all (bias/darks are stable across
 * sessions on a cooled camera and stay in the shared calibration pool; flats
 * correct for the optical train's state at capture time, so a flat set is
 * really only valid for the session(s) it was shot for).
 */
import { useMemo, useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Search, Loader2, AlertCircle, Check } from 'lucide-react';
import { getLibraryObjects, getLibrarySessions, attachCalibrationBundle, type CalibrationAttachmentSummary } from '../lib/api/library';
import { getInputClass } from './ui/formClasses';
import { Modal } from './ui/Modal';

/** "Whole object" is stored server-side as the empty string (see
 *  calibrationAttachments.ts's WHOLE_OBJECT_DATE) — mirrored here so the
 *  select's own sentinel value matches what the API expects verbatim. */
const WHOLE_OBJECT_DATE = '';

export function AttachCalibrationModal({
  isDark,
  scope,
  folderName,
  settingsKey,
  bundleLabel,
  onClose,
  onAttached,
}: {
  isDark: boolean;
  scope: string | null;
  folderName: string;
  settingsKey: string;
  /** e.g. "60s · Bin1 · gain100 · -8.0°C" — shown so the user can confirm
   *  they're attaching the bundle they think they are. */
  bundleLabel: string;
  onClose: () => void;
  onAttached: (attachment: CalibrationAttachmentSummary) => void;
}) {
  const { t } = useTranslation('library');
  const [search, setSearch] = useState('');
  const [objectId, setObjectId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(WHOLE_OBJECT_DATE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: ['library-objects-for-attach'],
    queryFn: getLibraryObjects,
    staleTime: 60_000,
  });

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['library-sessions-for-attach', objectId],
    queryFn: objectId !== null ? () => getLibrarySessions(objectId) : skipToken,
    enabled: objectId !== null,
  });

  const filtered = useMemo(() => {
    const list = objects ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(o => o.name.toLowerCase().includes(q) || o.folderName.toLowerCase().includes(q));
  }, [objects, search]);

  const selectedObject = objects?.find(o => o.id === objectId) ?? null;

  async function handleAttach() {
    if (!objectId) return;
    setPending(true);
    setError(null);
    try {
      const { attachment } = await attachCalibrationBundle({
        scope, folderName, key: settingsKey, objectId,
        ...(date !== WHOLE_OBJECT_DATE ? { date } : {}),
      });
      onAttached(attachment);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('calibrations.attachModal.error'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={t('calibrations.attachModal.dialogLabel')}>
      <div
        className={`w-full max-w-md rounded-2xl border shadow-xl ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
      >
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="min-w-0">
            <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>{t('calibrations.attachModal.title')}</h3>
            <p className={`text-xs mt-0.5 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{bundleLabel}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('calibrations.attachModal.close')}
            className={`p-1.5 rounded-lg transition shrink-0 ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {!selectedObject ? (
            <>
              <div className="relative">
                <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('calibrations.attachModal.searchPlaceholder')}
                  className={`${getInputClass(isDark)} pl-9`}
                />
              </div>
              <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-1">
                {objectsLoading && (
                  <div className="flex items-center gap-2 py-6 justify-center">
                    <Loader2 className={`w-4 h-4 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                  </div>
                )}
                {!objectsLoading && filtered.length === 0 && (
                  <p className={`text-sm text-center py-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('calibrations.attachModal.noMatches')}</p>
                )}
                {filtered.map(o => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => { setObjectId(o.id); setDate(WHOLE_OBJECT_DATE); }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left transition ${
                      isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{o.name}</span>
                    {o.sessionCount !== undefined && (
                      <span className={`text-xs shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {t('calibrations.attachModal.sessionCount', { count: o.sessionCount })}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <Check className={`w-4 h-4 shrink-0 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
                  <span className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{selectedObject.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setObjectId(null)}
                  className={`text-xs font-medium shrink-0 ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-500'}`}
                >
                  {t('calibrations.attachModal.change')}
                </button>
              </div>

              <div>
                <label className={`block text-[0.8125rem] font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {t('calibrations.attachModal.appliesTo')}
                </label>
                <select
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  disabled={sessionsLoading}
                  className={getInputClass(isDark)}
                >
                  <option value={WHOLE_OBJECT_DATE}>{t('calibrations.attachModal.everySession')}</option>
                  {(sessions ?? []).map(s => (
                    <option key={s.date} value={s.date}>{s.date}</option>
                  ))}
                </select>
                <p className={`text-xs mt-1.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('calibrations.attachModal.hint')}
                </p>
              </div>
            </>
          )}

          {error && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-700'}`}>
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t('calibrations.attachModal.cancel')}
          </button>
          <button
            type="button"
            onClick={handleAttach}
            disabled={!selectedObject || pending}
            className="px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {pending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('calibrations.attachModal.attach')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
