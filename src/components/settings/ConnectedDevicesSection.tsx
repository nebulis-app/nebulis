import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tv, Trash2, Pencil, Check, X, Loader2, QrCode } from 'lucide-react';
import { ConnectDeviceModal } from './ConnectDeviceModal';
import {
  getConnectedDevices,
  revokeConnectedDevice,
  renameConnectedDevice,
  adminGetAllDevices,
  adminRevokeDevice,
  type ConnectedDevice,
  type ConnectedDeviceWithOwner,
} from '../../lib/api/devices';
import { useAuth } from '../../contexts/AuthContext';
import { getCardClass, getInputClass } from './SettingsUI';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.round(day / 30);
  return `${mo} mo ago`;
}

type Scope = 'mine' | 'all';

export function ConnectedDevicesSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const cardClass = getCardClass(isDark);
  const inputClass = getInputClass(isDark);

  const [scope, setScope] = useState<Scope>('mine');

  const mineQuery = useQuery({
    queryKey: ['connected-devices', 'mine'],
    queryFn: getConnectedDevices,
    enabled: scope === 'mine',
  });
  const allQuery = useQuery({
    queryKey: ['connected-devices', 'all'],
    queryFn: adminGetAllDevices,
    enabled: scope === 'all' && isAdmin,
  });

  const isLoading = scope === 'mine' ? mineQuery.isLoading : allQuery.isLoading;
  // The "all" view returns `ConnectedDeviceWithOwner` (extends ConnectedDevice)
  // so a single mapping handles both shapes — owner-aware code lives behind
  // a runtime check on the `scope` flag, not a type narrow.
  const devices: (ConnectedDevice | ConnectedDeviceWithOwner)[] | undefined =
    scope === 'mine' ? mineQuery.data : allQuery.data;

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['connected-devices'] });
  };

  // User-scoped revoke (only the owner's own devices match server-side).
  const revokeMine = useMutation({
    mutationFn: revokeConnectedDevice,
    onSuccess: invalidateAll,
  });

  // Admin-scoped revoke (any device, regardless of owner). Used in the
  // "All Devices" view; gated to admins server-side.
  const revokeAny = useMutation({
    mutationFn: adminRevokeDevice,
    onSuccess: invalidateAll,
  });

  // Pick the right revoke flow based on which view we're in. Mutating from the
  // admin view always uses admin-revoke so an admin can clear someone else's
  // device without changing endpoints.
  function revokeDevice(id: string) {
    if (scope === 'all') revokeAny.mutate(id);
    else revokeMine.mutate(id);
  }

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameConnectedDevice(id, name),
    onSuccess: () => {
      setEditingId(null);
      invalidateAll();
    },
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  function beginRename(d: ConnectedDevice) {
    setEditingId(d.id);
    setEditingName(d.name);
  }

  function commitRename() {
    if (!editingId || !editingName.trim()) return;
    rename.mutate({ id: editingId, name: editingName.trim() });
  }

  return (
    <div className="space-y-6">
      {showConnect && <ConnectDeviceModal isDark={isDark} onClose={() => setShowConnect(false)} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className={`font-display text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Devices
          </h2>
          <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Phones and Apple TVs linked to your account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowConnect(true)}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-sm"
        >
          <QrCode className="w-4 h-4" />
          Connect a device
        </button>
      </div>

      <div className={cardClass}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex-1 min-w-0">
            <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              Linked devices
            </h3>
            <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {scope === 'all'
                ? 'Every device linked across all users.'
                : <>On your Apple TV, open Nebulis, then visit{' '}
                    <a
                      href={`${window.location.origin}/link`}
                      target="_blank"
                      rel="noreferrer"
                      className={`font-mono underline underline-offset-2 ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-700 hover:text-accent-600'}`}
                    >
                      {window.location.origin}/link
                    </a>{' '}
                    on this device to pair it.</>}
            </p>
          </div>

          {isAdmin && (
            <div
              role="tablist"
              aria-label="Device scope"
              className={`shrink-0 inline-flex rounded-full p-0.5 text-xs font-medium ${
                isDark ? 'bg-slate-800/80' : 'bg-slate-100'
              }`}
            >
              {(['mine', 'all'] as Scope[]).map(s => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={scope === s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`px-3 py-1 rounded-full transition-colors ${
                    scope === s
                      ? isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 shadow-sm'
                      : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {s === 'mine' ? 'Mine' : 'All Devices'}
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoading && (
          <div className={`flex items-center gap-2 text-sm py-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {!isLoading && devices && devices.length === 0 && (
          <div className={`text-center py-10 rounded-xl border-2 border-dashed ${isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
            <Tv className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No devices linked yet.</p>
            {scope === 'mine' && (
              <button
                type="button"
                onClick={() => setShowConnect(true)}
                className={`mt-3 inline-flex items-center gap-1.5 text-sm font-medium ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-700 hover:text-accent-600'}`}
              >
                <QrCode className="w-4 h-4" />
                Connect your phone
              </button>
            )}
          </div>
        )}

        {!isLoading && devices && devices.length > 0 && (
          <ul className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
            {devices.map(d => {
              const isEditing = editingId === d.id;
              const isConfirming = confirmingId === d.id;
              // Only present in the "all" view; falls through to undefined
              // in the user-scoped view so the JSX below can branch on it.
              const owner = 'ownerUsername' in d ? d : null;
              return (
                <li key={d.id} className="py-3 flex items-center gap-4">
                  <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
                    isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-600'
                  }`}>
                    <Tv className="w-5 h-5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className={inputClass}
                      />
                    ) : (
                      <>
                        <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                          {d.name}
                          {owner && (
                            <span className={`ml-2 text-xs font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                              ·{' '}
                              {owner.ownerUsername
                                ? <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                                    {owner.ownerDisplayName || owner.ownerUsername}
                                    {owner.ownerDisplayName && owner.ownerDisplayName !== owner.ownerUsername && (
                                      <span className={isDark ? 'text-slate-600' : 'text-slate-400'}> @{owner.ownerUsername}</span>
                                    )}
                                  </span>
                                : <span className="italic">deleted user</span>}
                            </span>
                          )}
                        </div>
                        <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                          Linked {relativeTime(d.createdAt)} · last seen {relativeTime(d.lastSeenAt)}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-1">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          aria-label="Save name"
                          onClick={commitRename}
                          disabled={rename.isPending}
                          className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-emerald-400' : 'hover:bg-slate-100 text-emerald-600'}`}
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel"
                          onClick={() => setEditingId(null)}
                          className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : isConfirming ? (
                      <>
                        <span className={`text-xs mr-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          Disconnect?
                        </span>
                        <button
                          type="button"
                          onClick={() => { revokeDevice(d.id); setConfirmingId(null); }}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500 text-white hover:bg-rose-600 transition-colors"
                        >
                          Disconnect
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingId(null)}
                          className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Renaming is owner-only — hidden when an admin is
                            viewing someone else's device in the All Devices tab. */}
                        {scope === 'mine' && (
                          <button
                            type="button"
                            aria-label="Rename device"
                            onClick={() => beginRename(d)}
                            className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-slate-200' : 'hover:bg-slate-100 text-slate-500 hover:text-slate-700'}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Disconnect device"
                          onClick={() => setConfirmingId(d.id)}
                          className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-rose-500/15 text-slate-400 hover:text-rose-400' : 'hover:bg-rose-50 text-slate-500 hover:text-rose-600'}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
