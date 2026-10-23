import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { ArrowRight, X } from 'lucide-react';
import { reassignTelescopeSessions, type TelescopeProfile } from '../../lib/api/telescopes';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';

/**
 * "Move all sessions from telescope A → B" picker.
 *
 * Used for hardware replacement (e.g. broken S30 → new S50). Lists every
 * non-archived telescope except the source as a target, calls the bulk
 * reassign endpoint, and reports how many rows moved.
 */
export function ReassignTelescopeModal({
  source,
  candidates,
  isDark,
  onClose,
}: {
  source: TelescopeProfile;
  candidates: TelescopeProfile[];
  isDark: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const { isNight } = useTheme();
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState<string>(candidates[0]?.id ?? '');
  const [result, setResult] = useState<{ sessionsUpdated: number; objectsUpdated: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => reassignTelescopeSessions(source.id, targetId),
    onSuccess: data => {
      setResult(data);
      setErrorMsg(null);
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      // ['objects'] is never used as a query key anywhere in the frontend —
      // invalidating it was a no-op. 'library-objects' is what Gallery.tsx
      // actually queries; without it, the gallery kept showing sessions
      // under their old telescope until an unrelated refetch happened to
      // land.
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
    },
    onError: (e: Error) => setErrorMsg(e.message),
  });

  const sessionCount = source.sessionCount ?? 0;

  return (
    <Modal isOpen onClose={onClose} title={t('reassignTelescopeModal.ariaLabel')}>
      <div
        className={`w-full max-w-md rounded-2xl border shadow-xl ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/60 dark:border-slate-800/60">
          <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
            {t('reassignTelescopeModal.title')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('reassignTelescopeModal.close')}
            className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {result ? (
            <div className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <Trans
                i18nKey={result.sessionsUpdated === 1 ? 'reassignTelescopeModal.movedSessions_one' : 'reassignTelescopeModal.movedSessions_other'}
                ns="settings"
                values={{ count: result.sessionsUpdated }}
                components={{ 1: <strong /> }}
              />
              {' '}
              <Trans
                i18nKey={result.objectsUpdated === 1 ? 'reassignTelescopeModal.movedObjects_one' : 'reassignTelescopeModal.movedObjects_other'}
                ns="settings"
                values={{ count: result.objectsUpdated }}
                components={{ 1: <strong /> }}
              />
              {' '}
              {t('reassignTelescopeModal.futureSyncsNote')}
            </div>
          ) : (
            <>
              <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {sessionCount > 0 ? (
                  <Trans
                    i18nKey={sessionCount === 1 ? 'reassignTelescopeModal.moveExplanationWithCount_one' : 'reassignTelescopeModal.moveExplanationWithCount_other'}
                    ns="settings"
                    values={{ name: source.name, count: sessionCount }}
                    components={{ 1: <strong /> }}
                  />
                ) : (
                  <Trans
                    i18nKey="reassignTelescopeModal.moveExplanationNoCount"
                    ns="settings"
                    values={{ name: source.name }}
                    components={{ 1: <strong /> }}
                  />
                )}
              </p>

              <div className="flex items-center gap-3">
                {/* Source — read-only */}
                <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2 ${
                  isDark ? 'bg-slate-800/50 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: nightSafeColor(source.color || '#8b5cf6', isNight) }}
                    />
                    <span className="text-sm truncate" title={source.name}>{source.name}</span>
                  </div>
                </div>

                <ArrowRight className={`shrink-0 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />

                {/* Target — picker */}
                {candidates.length === 0 ? (
                  <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2 text-sm italic ${
                    isDark ? 'bg-slate-800/50 border-slate-700 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'
                  }`}>
                    {t('reassignTelescopeModal.noOtherTelescope')}
                  </div>
                ) : (
                  <select
                    value={targetId}
                    onChange={e => setTargetId(e.target.value)}
                    className={`flex-1 min-w-0 rounded-lg border px-3 py-2 text-sm ${
                      isDark
                        ? 'bg-slate-800 border-slate-700 text-slate-200'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    {candidates.map(candidate => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {errorMsg && (
                <p className="text-sm text-rose-500">{errorMsg}</p>
              )}
            </>
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-200/60'
        }`}>
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition"
            >
              {t('reassignTelescopeModal.done')}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t('reassignTelescopeModal.cancel')}
              </button>
              <button
                type="button"
                onClick={() => mutation.mutate()}
                disabled={!targetId || mutation.isPending || candidates.length === 0}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  !targetId || candidates.length === 0
                    ? isDark ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-accent-500 text-white hover:bg-accent-600'
                }`}
              >
                {mutation.isPending ? t('reassignTelescopeModal.moving') : t('reassignTelescopeModal.moveSessionsButton')}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
