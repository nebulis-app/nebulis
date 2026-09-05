import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, HardDrive, Loader2, Network, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
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
        <div className={`text-[11px] font-medium uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {label}
          {missing && (
            <span className={`ml-2 normal-case tracking-normal ${isDark ? 'text-amber-400/80' : 'text-amber-600'}`}>
              not found on disk
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
        title="Copy path"
        className={`shrink-0 rounded-lg p-2 transition ${
          copied
            ? 'text-emerald-500'
            : isDark
              ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
        }`}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">Copy path</span>
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
  const { data, isLoading, isError } = useQuery({
    queryKey: ['object-location', objectId, date ?? null],
    queryFn: () => getObjectLocation(objectId, date),
    staleTime: 60 * 1000,
  });

  const primary: DiskLocation | null = data ? (date ? data.session : data.object) : null;
  const primaryLabel = date ? 'Session folder' : 'Object folder';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`File location for ${displayName}`}
      className={`mx-4 w-full max-w-lg rounded-2xl border shadow-2xl ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          {date ? 'Session file location' : 'File location'}
        </h3>
        <button
          onClick={onClose}
          className={`rounded-lg p-1.5 transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </button>
      </div>

      <div className="space-y-5 px-5 py-4">
        {isLoading && (
          <div className={`flex items-center gap-2 py-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Resolving location…
          </div>
        )}

        {isError && (
          <p className={`py-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Could not resolve the file location.
          </p>
        )}

        {data && (
          <Section icon={data.storage === 'network' ? Network : HardDrive} title="On disk">
            {primary ? (
              <PathRow label={primaryLabel} value={primary.path} missing={!primary.exists} />
            ) : (
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                No folder recorded for this session.
              </p>
            )}

            {!date &&
              data.variants.map(v => (
                <PathRow key={v.objectId} label={`${v.label} folder`} value={v.path} missing={!v.exists} />
              ))}

            <p className={`pt-1 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {data.storage === 'network'
                ? 'The library is on a network share. This path is as the server sees it; on your own machine the share may be mapped to a different drive letter or mount point.'
                : 'This is the path on the machine running Nebulis.'}
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
          Done
        </button>
      </div>
    </Modal>
  );
}
