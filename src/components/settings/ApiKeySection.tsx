import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Key, Copy, Check, Trash2, Plus, Clock, Laptop } from 'lucide-react';
import { getUserApiKeys, createUserApiKey, deleteUserApiKey, type UserApiKey } from '../../lib/api/settings';
import { Sec } from './SettingsUI';
import { ConfirmModal } from '../ConfirmModal';

const MAX_KEYS = 5;

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

export function ApiKeySection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [newKeyData, setNewKeyData] = useState<{ apiKey: string; name: string } | null>(null);
  const [keyToRevoke, setKeyToRevoke] = useState<UserApiKey | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['user-api-keys'],
    queryFn: getUserApiKeys,
  });

  const keys = data?.keys || [];
  const canCreate = keys.length < MAX_KEYS;

  const createMutation = useMutation({
    mutationFn: (name: string) => createUserApiKey(name),
    onSuccess: (res) => {
      setNewKeyData({ apiKey: res.apiKey, name: res.name });
      setIsCreating(false);
      setNewKeyName('');
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUserApiKey(id),
    onSuccess: () => {
      setKeyToRevoke(null);
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    const name = newKeyName.trim() || `API Key ${keys.length + 1}`;
    createMutation.mutate(name);
  };

  return (
    <>
      <Sec
        title="API Keys"
        description="User-linked API keys for PixInsight, automated scripts, and external tools (up to 5 keys)."
        isDark={isDark}
        actions={
          <div className="flex items-center gap-3">
            <span className={`text-xs font-medium px-2 py-1 rounded-md border ${
              keys.length >= MAX_KEYS
                ? isDark ? 'border-amber-700/60 bg-amber-950/40 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800'
                : isDark ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-600'
            }`}>
              {keys.length} / {MAX_KEYS} keys
            </span>

            {canCreate && !isCreating && (
              <button
                type="button"
                onClick={() => {
                  setNewKeyName(`PixInsight ${keys.length === 0 ? '' : keys.length + 1}`.trim());
                  setIsCreating(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                New API Key
              </button>
            )}
          </div>
        }
      >
        <div className="p-5 space-y-4">
          <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            API keys are securely linked to your account. Requests authenticated with your key carry your
            user permissions and automatically attribute object favorites, notes, and activity to you.
          </p>

          {/* New key creation inline form */}
          {isCreating && (
            <form
              onSubmit={handleCreateSubmit}
              className={`p-4 rounded-xl border ${
                isDark ? 'bg-slate-900/80 border-slate-700' : 'bg-slate-50 border-slate-300'
              } space-y-3`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  Create New API Key ({keys.length + 1} of {MAX_KEYS})
                </span>
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className={`text-xs ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  Cancel
                </button>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  placeholder="Key label e.g. PixInsight Workstation, Desktop, MacBook"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  autoFocus
                  maxLength={50}
                  className={`flex-1 text-xs px-3 py-2 rounded-lg border outline-none transition-colors ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-slate-100 focus:border-accent-500'
                      : 'bg-white border-slate-300 text-slate-900 focus:border-accent-600'
                  }`}
                />
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-sm disabled:opacity-50"
                >
                  <Key className="w-3.5 h-3.5" />
                  {createMutation.isPending ? 'Generating...' : 'Create Key'}
                </button>
              </div>
            </form>
          )}

          {/* Newly generated secret banner */}
          {newKeyData && (
            <div className={`p-4 rounded-xl border ${
              isDark ? 'bg-emerald-950/40 border-emerald-800/80' : 'bg-emerald-50 border-emerald-300'
            } space-y-2.5 animate-fadeIn`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white text-xs font-bold">
                    ✓
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-emerald-300' : 'text-emerald-800'}`}>
                    API Key Created: {newKeyData.name}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setNewKeyData(null)}
                  className={`text-xs underline ${isDark ? 'text-emerald-400 hover:text-emerald-300' : 'text-emerald-700 hover:text-emerald-800'}`}
                >
                  Dismiss
                </button>
              </div>

              <p className={`text-xs ${isDark ? 'text-emerald-400/90' : 'text-emerald-700'}`}>
                <strong>Save this key now!</strong> For security reasons, the full key is never stored in plaintext and cannot be shown again.
              </p>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  readOnly
                  value={newKeyData.apiKey}
                  className={`flex-1 font-mono text-xs px-3 py-2 rounded-lg border select-all ${
                    isDark ? 'bg-slate-900 border-slate-700 text-emerald-300' : 'bg-white border-emerald-300 text-emerald-800'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => handleCopy(newKeyData.apiKey)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                    copiedKey === newKeyData.apiKey
                      ? 'bg-emerald-600 text-white'
                      : isDark
                        ? 'bg-emerald-700 text-white hover:bg-emerald-600'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  {copiedKey === newKeyData.apiKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === newKeyData.apiKey ? 'Copied!' : 'Copy Key'}
                </button>
              </div>
            </div>
          )}

          {/* List of active keys */}
          <div className="space-y-2 pt-1">
            {isLoading ? (
              <div className={`p-4 text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                Loading API keys...
              </div>
            ) : keys.length === 0 ? (
              <div className={`p-6 rounded-xl border text-center space-y-3 ${
                isDark ? 'border-slate-800 bg-slate-900/40 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}>
                <Key className="w-8 h-8 mx-auto opacity-50" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">No API keys yet</p>
                  <p className="text-xs">Create your first API key to connect PixInsight or automated workflows.</p>
                </div>
                {!isCreating && (
                  <button
                    type="button"
                    onClick={() => {
                      setNewKeyName('PixInsight Connector');
                      setIsCreating(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-sm"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create an API Key
                  </button>
                )}
              </div>
            ) : (
              keys.map((k) => (
                <div
                  key={k.id}
                  className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
                    isDark ? 'border-slate-800 bg-slate-900/60 hover:border-slate-700' : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`p-2 rounded-lg shrink-0 ${isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-600'}`}>
                      <Laptop className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                          {k.name || 'API Key'}
                        </span>
                        <code className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${
                          isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {k.keyPrefix}
                        </code>
                      </div>
                      <div className={`flex items-center gap-3 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        <span>Created {relativeTime(k.createdAt)}</span>
                        <span>&bull;</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {k.lastUsedAt ? `Used ${relativeTime(k.lastUsedAt)}` : 'Never used'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <button
                      type="button"
                      onClick={() => setKeyToRevoke(k)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 transition-colors"
                      title="Revoke this API key"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Revoke
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Sec>

      {/* PixInsight Quick Start Guide */}
      <Sec
        title="Using with PixInsight"
        description="Connect your PixInsight plugin to Nebulis using any of your active keys."
        isDark={isDark}
      >
        <div className="p-5 space-y-3">
          <ol className={`text-xs space-y-2 list-decimal list-inside leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            <li>Create an API key above (e.g. named <em>PixInsight Workstation</em>) and copy the generated key.</li>
            <li>In PixInsight, open: <strong>Script &gt; Nebulis &gt; Nebulis Connector</strong>.</li>
            <li>Switch to the <strong>Settings &amp; Connection</strong> tab.</li>
            <li>Paste your key into the <strong>Nebulis API Key</strong> field.</li>
            <li>Click <strong>Test Connection</strong> to verify, then click <strong>Save Settings</strong>.</li>
          </ol>

          <p className={`text-xs pt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            The connector script sends this key via the <code>X-API-Key</code> HTTP header. All operations performed from PixInsight will be linked to your user account.
          </p>
        </div>
      </Sec>

      {keyToRevoke && (
        <ConfirmModal
          title={`Revoke "${keyToRevoke.name}"?`}
          message={`Are you sure you want to revoke the key with prefix ${keyToRevoke.keyPrefix}? Any application or PixInsight connector currently using this key will immediately be disconnected.`}
          confirmLabel="Revoke Key"
          pending={deleteMutation.isPending}
          onCancel={() => setKeyToRevoke(null)}
          onConfirm={() => deleteMutation.mutate(keyToRevoke.id)}
        />
      )}
    </>
  );
}
