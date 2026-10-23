import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, HardDrive, Loader2, Network, X } from 'lucide-react';
import { Modal } from './Modal';
import { useTheme } from '../../hooks/useTheme';
import { getObjectLocation, type DiskLocation } from '../../lib/api/library';

/** One copyable path. Truncates in the middle so the filename-carrying tail
 *  stays visible, with the full path in the title and on copy. */
function PathRow({
  label,
  value,
  missing,
}: {
  label: string;
  value: string;
  missing?: boolean;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the value is still selectable in the field */
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className={`text-[0.6875rem] font-medium uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {label}
          {missing && (
            <span className={`ml-2 normal-case tracking-normal ${isDark ? 'text-amber-400/80' : 'text-amber-600'}`}>
              {t('fileLocationModal.notFoundOnDisk')}
            </span>
          )}
        </div>
        <div
          title={value}
          className={`overflow-x-auto whitespace-nowrap rounded-lg px-2.5 py-1.5 font-mono text-xs ${
            isDark ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-700'
          }`}
        >
          {value}
        </div>
      </div>
      <button
        onClick={copy}
        title={t('fileLocationModal.copyPath')}
        className={`shrink-0 rounded-lg p-2 transition ${
          copied
            ? 'text-emerald-500'
            : isDark
              ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
        }`}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">{t('fileLocationModal.copyPath')}</span>
      </button>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof HardDrive;
  title: string;
  children: React.ReactNode;
}) {
  const { isDark } = useTheme();
  return (
    <div>
      <div className={`mb-2 flex items-center gap-2 text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
        <Icon className={`h-4 w-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
        {title}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

export function FileLocationModal({
  objectId,
  date,
  displayName,
  onClose,
}: {
  objectId: string;
  /** Present for a session; absent for the whole object. */
  date?: string;
  displayName: string;
  onClose: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['object-location', objectId, date ?? null],
    queryFn: () => getObjectLocation(objectId, date),
    staleTime: 60 * 1000,
  });

  // Older servers, and test mocks, do not send `linked`.
  const linkedFolders = data?.linked ?? [];
  const primary: DiskLocation | null = data ? (date ? data.session : data.object) : null;
  const primaryLabel = date ? t('fileLocationModal.sessionFolder') : t('fileLocationModal.objectFolder');

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('fileLocationModal.titleFor', { name: displayName })}
      className={`mx-4 w-full max-w-lg rounded-2xl border shadow-2xl ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          {date ? t('fileLocationModal.sessionFileLocation') : t('fileLocationModal.fileLocation')}
        </h3>
        <button
          onClick={onClose}
          className={`rounded-lg p-1.5 transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{t('fileLocationModal.close')}</span>
        </button>
      </div>

      <div className="space-y-5 px-5 py-4">
        {isLoading && (
          <div className={`flex items-center gap-2 py-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('fileLocationModal.resolvingLocation')}
          </div>
        )}

        {isError && (
          <p className={`py-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {t('fileLocationModal.resolveFailed')}
          </p>
        )}

        {data && (
          <Section icon={data.storage === 'network' ? Network : HardDrive} title={t('fileLocationModal.onDisk')}>
            {primary?.path ? (
              <PathRow label={primaryLabel} value={primary.path} missing={!primary.exists} />
            ) : linkedFolders.length === 0 ? (
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {t('fileLocationModal.noFolderRecorded')}
              </p>
            ) : null}

            {linkedFolders.map(l => (
              <PathRow
                key={l.sourceId}
                label={t('fileLocationModal.linkedFolder', { name: l.sourceLabel })}
                value={l.path}
                missing={!l.exists}
              />
            ))}

            {!date &&
              data.variants.map(v => (
                <PathRow key={v.objectId} label={t('fileLocationModal.variantFolder', { label: v.label })} value={v.path} missing={!v.exists} />
              ))}

            <p className={`pt-1 text-[0.6875rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {linkedFolders.length > 0 && !primary?.path
                ? t('fileLocationModal.linkedNote')
                : data.storage === 'network'
                  ? t('fileLocationModal.networkNote')
                  : t('fileLocationModal.localNote')}
            </p>
          </Section>
        )}
      </div>

      <div className={`border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <button
          onClick={onClose}
          className={`ml-auto block rounded-xl px-4 py-2 text-sm font-medium transition ${
            isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {t('fileLocationModal.done')}
        </button>
      </div>
    </Modal>
  );
}
