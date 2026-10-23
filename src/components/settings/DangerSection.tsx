import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, RotateCw, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { resetDatabase } from '../../lib/api/settings';
import { Sec, Row } from './SettingsUI';
import { Modal } from '../ui/Modal';

function DeleteConfirmModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState('');

  // The displayed instruction, the input placeholder, and this check all
  // read from the same key so they can never drift apart — a German UI that
  // told the user to type "löschen" but still checked for the English word
  // "delete" would be a real, confusing bug, not just an untranslated string.
  const deleteWord = t('dangerSection.deleteConfirmModal.deleteWord');

  const resetDb = useMutation({
    mutationFn: resetDatabase,
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });

  const canConfirm = confirmText === deleteWord && !resetDb.isPending && !resetDb.isSuccess;
  const handleModalClose = () => { if (!resetDb.isPending) onClose(); };

  return (
    <Modal isOpen onClose={handleModalClose} title={t('dangerSection.deleteConfirmModal.typeToConfirmBefore')}>
      <div className={`relative w-full max-w-md rounded-2xl shadow-2xl p-6 ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
        {!resetDb.isSuccess && !resetDb.isPending && (
          <button
            onClick={onClose}
            className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {resetDb.isSuccess ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <div>
              <p className={`font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{t('dangerSection.deleteConfirmModal.success')}</p>
              <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t('dangerSection.deleteConfirmModal.successDescription')}</p>
            </div>
            <button
              onClick={onClose}
              className="mt-2 px-5 py-2 rounded-lg text-sm font-semibold bg-slate-600 text-white hover:bg-slate-500 transition-colors"
            >
              {t('dangerSection.deleteConfirmModal.close')}
            </button>
          </div>
        ) : (
          <>
            <div className={`flex items-center gap-3 mb-5 p-3 rounded-xl ${isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'}`}>
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
              <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                {t('dangerSection.deleteConfirmModal.warning')}
              </p>
            </div>

            <p className={`text-sm font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {t('dangerSection.deleteConfirmModal.typeToConfirmBefore')}{' '}
              <span className={`font-mono font-bold ${isDark ? 'text-red-400' : 'text-red-600'}`}>{deleteWord}</span>{' '}
              {t('dangerSection.deleteConfirmModal.typeToConfirmAfter')}
            </p>
            <input
              type="text"
              placeholder={deleteWord}
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              disabled={resetDb.isPending}
              autoFocus
              className={`w-full px-3 py-2 rounded-lg border text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:opacity-40 mb-4 ${
                isDark
                  ? 'bg-slate-800 border-red-500/20 text-slate-200 placeholder-slate-600 focus:border-red-500/40'
                  : 'bg-white border-red-200 text-slate-800 placeholder-slate-400 focus:border-red-400'
              }`}
            />

            <div className="flex gap-3">
              <button
                onClick={() => !resetDb.isPending && onClose()}
                disabled={resetDb.isPending}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isDark ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                {t('dangerSection.deleteConfirmModal.cancel')}
              </button>
              <button
                onClick={() => resetDb.mutate()}
                disabled={!canConfirm}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20"
              >
                {resetDb.isPending ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" />
                    {t('dangerSection.deleteConfirmModal.deleting')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    {t('dangerSection.deleteConfirmModal.deleteButton')}
                  </>
                )}
              </button>
            </div>

            {resetDb.isError && (
              <p className="flex items-center gap-1.5 text-xs text-red-500 mt-3">
                <AlertCircle className="w-3.5 h-3.5" />
                {resetDb.error instanceof Error ? resetDb.error.message : t('dangerSection.deleteConfirmModal.genericError')}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export function DangerSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <Sec
        title={t('dangerSection.deleteAllData.title')}
        description={t('dangerSection.deleteAllData.description')}
        isDark={isDark}
      >
        <Row label={t('dangerSection.deleteAllData.resetLabel')} description={t('dangerSection.deleteAllData.resetDescription')} isDark={isDark}>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20"
          >
            <Trash2 className="w-4 h-4" />
            {t('dangerSection.deleteAllData.button')}
          </button>
        </Row>
      </Sec>

      {showModal && (
        <DeleteConfirmModal isDark={isDark} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
