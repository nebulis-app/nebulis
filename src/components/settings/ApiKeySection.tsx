import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Key, Copy, Check, Trash2, Plus, Loader2 } from 'lucide-react';
import { getApiKeys, createApiKey, revokeApiKeyById, type UserApiKey, type CreatedApiKey } from '../../lib/api/settings';
import { useAuth } from '../../contexts/AuthContext';
import { Sec, Seg, getInputClass } from './SettingsUI';
import { ConfirmModal } from '../ConfirmModal';
import { formatRelativeDuration } from '../../lib/formatLocale';

type Scope = 'mine' | 'all';

function relativeTime(ms: number, justNow: string): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return justNow;
  const min = Math.round(sec / 60);
  if (min < 60) return formatRelativeDuration(min, 'minute', 'narrow');
  const hr = Math.round(min / 60);
  if (hr < 24) return formatRelativeDuration(hr, 'hour', 'narrow');
  const day = Math.round(hr / 24);
  if (day < 30) return formatRelativeDuration(day, 'day', 'narrow');
  return formatRelativeDuration(Math.round(day / 30), 'month', 'narrow');
}

/** Personal API keys: for PixInsight and other tools that act as you. */
export function ApiKeySection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const inputClass = getInputClass(isDark);

  const [scope, setScope] = useState<Scope>('mine');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<UserApiKey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', scope],
    queryFn: () => getApiKeys(scope),
  });
  const keys = data?.keys ?? [];
  const max = data?.max ?? 5;
  const ownKeyCount = useQuery({ queryKey: ['api-keys', 'mine'], queryFn: () => getApiKeys('mine'), enabled: scope === 'all' }).data?.keys.length;
  const used = scope === 'mine' ? keys.length : (ownKeyCount ?? 0);
  const canCreate = used < max;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  const create = useMutation({
    mutationFn: createApiKey,
    onSuccess: created => {
      setFresh(created);
      setCreating(false);
      setName('');
      void invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: revokeApiKeyById,
    onSuccess: () => {
      setToRevoke(null);
      void invalidate();
    },
  });

  const copyKey = () => {
    if (!fresh) return;
    void navigator.clipboard.writeText(fresh.apiKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked: the key is selectable in the field */ });
  };

  const muted = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <>
      <Sec
        title={t('apiKeys.title')}
        description={t('apiKeys.description')}
        isDark={isDark}
        actions={canCreate && !creating && scope === 'mine' ? (
          <button
            type="button"
            onClick={() => { setName(''); setCreating(true); setFresh(null); }}
            className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            {t('apiKeys.newKey')}
          </button>
        ) : undefined}
      >
        <div className={`flex items-start justify-between gap-4 px-5 py-4 border-b ${isDark ? 'border-slate-800/70' : 'border-slate-100'}`}>
          <p className={`text-xs flex-1 min-w-0 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            {scope === 'all' ? t('apiKeys.allNote') : t('apiKeys.note', { used, max })}
          </p>
          {isAdmin && (
            <Seg<Scope>
              value={scope}
              onChange={setScope}
              isDark={isDark}
              options={[
                { id: 'mine', label: t('apiKeys.mine') },
                { id: 'all', label: t('apiKeys.all') },
              ]}
            />
          )}
        </div>

        <div className="p-4 space-y-4">
          {fresh && (
            <div className={`rounded-xl border p-4 space-y-2 ${isDark ? 'border-emerald-800/70 bg-emerald-950/30' : 'border-emerald-300 bg-emerald-50'}`}>
              <div className="flex items-center justify-between gap-3">
                <p className={`text-sm font-semibold ${isDark ? 'text-emerald-300' : 'text-emerald-800'}`}>
                  {t('apiKeys.createdTitle', { name: fresh.name })}
                </p>
                <button type="button" onClick={() => setFresh(null)} className={`text-xs underline ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                  {t('apiKeys.dismiss')}
                </button>
              </div>
              <p className={`text-xs ${isDark ? 'text-emerald-400/90' : 'text-emerald-700'}`}>{t('apiKeys.copyOnce')}</p>
              <div className="flex items-center gap-2">
                <input readOnly value={fresh.apiKey} onFocus={e => e.currentTarget.select()} className={`${inputClass} font-mono text-xs`} />
                <button
                  type="button"
                  onClick={copyKey}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
                </button>
              </div>
            </div>
          )}

          {creating && (
            <form
              onSubmit={e => { e.preventDefault(); create.mutate(name.trim()); }}
              className={`rounded-xl border p-4 flex flex-col sm:flex-row gap-2 ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}
            >
              <input
                autoFocus
                value={name}
                maxLength={50}
                onChange={e => setName(e.target.value)}
                placeholder={t('apiKeys.namePlaceholder')}
                aria-label={t('apiKeys.nameLabel')}
                className={inputClass}
              />
              <div className="flex gap-2 shrink-0">
                <button
                  type="submit"
                  disabled={create.isPending}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[0.8125rem] font-medium bg-accent-500 text-white hover:bg-accent-600 transition-colors disabled:opacity-50"
                >
                  {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                  {t('apiKeys.create')}
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className={`px-3 py-2 rounded-lg text-[0.8125rem] font-medium ${isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {t('apiKeys.cancel')}
                </button>
              </div>
            </form>
          )}
          {create.isError && (
            <p className="text-xs text-rose-500">{create.error instanceof Error ? create.error.message : t('apiKeys.createFailed')}</p>
          )}

          {isLoading && (
            <div className={`flex items-center gap-2 text-sm py-4 ${muted}`}>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('apiKeys.loading')}
            </div>
          )}

          {!isLoading && keys.length === 0 && (
            <div className={`text-center py-10 rounded-xl border-2 border-dashed ${isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
              <Key className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{t('apiKeys.none')}</p>
              <p className="text-xs mt-1">{t('apiKeys.noneHint')}</p>
            </div>
          )}

          {!isLoading && keys.length > 0 && (
            <ul className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
              {keys.map(k => (
                <li key={k.id} className="py-3 flex items-center gap-4">
                  <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-600'}`}>
                    <Key className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                      {k.name}
                      <code className={`ml-2 text-[0.6875rem] px-1.5 py-0.5 rounded font-mono ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'}`}>{k.keyPrefix}</code>
                      {scope === 'all' && (
                        <span className={`ml-2 text-xs font-normal ${muted}`}>
                          · {k.ownerUsername
                            ? (k.ownerDisplayName || k.ownerUsername)
                            : <span className="italic">{t('apiKeys.deletedUser')}</span>}
                        </span>
                      )}
                    </div>
                    <div className={`text-xs mt-0.5 ${muted}`}>
                      {t('apiKeys.created', { when: relativeTime(k.createdAt, t('apiKeys.justNow')) })}
                      {' · '}
                      {k.lastUsedAt ? t('apiKeys.lastUsed', { when: relativeTime(k.lastUsedAt, t('apiKeys.justNow')) }) : t('apiKeys.neverUsed')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setToRevoke(k)}
                    aria-label={t('apiKeys.revokeAria', { name: k.name })}
                    className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      isDark ? 'border-rose-500/30 text-rose-400 hover:bg-rose-500/10' : 'border-rose-300 text-rose-600 hover:bg-rose-50'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('apiKeys.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sec>

      {toRevoke && (
        <ConfirmModal
          title={t('apiKeys.revokeTitle', { name: toRevoke.name })}
          message={t('apiKeys.revokeMessage', { prefix: toRevoke.keyPrefix })}
          confirmLabel={t('apiKeys.revokeConfirm')}
          pending={revoke.isPending}
          onCancel={() => setToRevoke(null)}
          onConfirm={() => revoke.mutate(toRevoke.id)}
        />
      )}
    </>
  );
}
