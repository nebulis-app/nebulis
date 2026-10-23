import { useState } from 'react';
import { leadLabel } from './alertLead';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Smartphone, Send, Trash2, Pencil, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  ALERT_EVENTS,
  NO_ALERT_DETAILS,
  deleteAlertDevice,
  testAlertDevice,
  updateAlertDevice,
  type AlertDetails,
  type AlertDevice,
  type AlertEventType,
} from '../../lib/api/alerts';
import { activeLocale } from '../../lib/formatLocale';
import { Modal } from '../ui/Modal';
import { Toggle, getInputClass } from './SettingsUI';
import { AlertEventChoices } from './AlertEventChoices';

/** The phone dialog's working copy. */
interface PhoneDraft {
  id: string;
  name: string;
  events: AlertEventType[];
  details: AlertDetails;
  error: string | null;
}

/**
 * The phones in Settings → Alerts, as rows of the same list as the channels. A phone is one that asked, from the Nebulis app, to get alerts as
 * push notifications: it appears by itself once it turns alerts on, and here an admin chooses what it gets, pauses it, tries it, or removes it.
 * The Apple token and the relay credential stay on the server. Rendered inside the list's `<ul>`, so it returns list items.
 */
export function AlertPhoneRows({ isDark, devices, onChanged }: { isDark: boolean; devices: AlertDevice[]; onChanged: () => void }) {
  const { t } = useTranslation('settings');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; error: string | null; removed: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PhoneDraft | null>(null);
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : t('alerts.actionFailed'));

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { enabled?: boolean } }) => updateAlertDevice(id, patch),
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: fail,
  });
  const saveDraft = useMutation({
    mutationFn: (d: PhoneDraft) => updateAlertDevice(d.id, { name: d.name.trim(), events: d.events, details: d.details }),
    onSuccess: () => { setDraft(null); onChanged(); },
    onError: (err, d) => setDraft(cur => (cur && cur.id === d.id ? { ...cur, error: err instanceof Error ? err.message : t('alerts.saveFailed') } : cur)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAlertDevice(id),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmingId(null); onChanged(); },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: (id: string) => testAlertDevice(id),
    onMutate: () => setError(null),
    onSuccess: (res, id) => { setTests(prev => ({ ...prev, [id]: { ok: res.ok, error: res.error, removed: res.removed } })); onChanged(); },
    onError: fail,
  });

  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const neutral = isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const faint = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString(activeLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      {error && (
        <li className="px-3.5 py-3">
          <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>{error}</div>
        </li>
      )}
      {devices.map(d => {
        const busy = (test.isPending && test.variables === d.id) || (remove.isPending && remove.variables === d.id);
        const tested = tests[d.id];
        const extras = [d.details?.plan ? t('alerts.detail.plan.label') : null, d.details?.dew ? t('alerts.detail.dew.label') : null].filter(Boolean);
        return (
          <li key={d.id} className="px-3.5 py-3 space-y-2">
            <div className="flex items-start gap-3">
              <Smartphone className={`w-4 h-4 mt-0.5 shrink-0 ${d.enabled ? (isDark ? 'text-accent-400' : 'text-accent-600') : faint}`} />
              <div className="min-w-0 flex-1">
                <p className={`text-[0.8125rem] font-medium ${strong}`}>
                  {d.name}
                  {!/iphone/i.test(d.name) && <span className={`ml-2 text-[0.6875rem] font-normal ${faint}`}>{t('alerts.phones.kind')}</span>}
                  {d.apnsEnv === 'sandbox' && (
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-[0.6562rem] font-medium ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                      {t('alerts.phones.testBuild')}
                    </span>
                  )}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {d.events.length === 0 ? (
                    <span className={`text-[0.7188rem] ${subtle}`}>{t('alerts.noEvents')}</span>
                  ) : ALERT_EVENTS.filter(e => d.events.includes(e)).map(e => (
                    <span
                      key={e}
                      className={`rounded-full px-2 py-0.5 text-[0.6562rem] font-medium ${isDark ? 'bg-accent-500/10 text-accent-300' : 'bg-accent-50 text-accent-700'}`}
                    >
                      {t(`alerts.event.${e}.short`)}
                    </span>
                  ))}
                </div>
                {d.events.includes('night.dew') && (
                  <p className={`mt-1.5 text-[0.7188rem] ${subtle}`}>{t('alerts.detail.dewRow', { time: leadLabel(d.details?.dewLeadMinutes ?? 60, t) })}</p>
                )}
                {d.events.includes('night.clear') && extras.length > 0 && (
                  <p className={`mt-1.5 text-[0.7188rem] ${subtle}`}>{t('alerts.phones.extras', { list: extras.join(', ') })}</p>
                )}
                {d.lastSentAt && (
                  <p className={`mt-1.5 inline-flex items-center gap-1.5 text-[0.7188rem] ${d.lastStatus === 'error' ? (isDark ? 'text-amber-300' : 'text-amber-700') : subtle}`}>
                    {d.lastStatus === 'error' ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                    {d.lastStatus === 'error'
                      ? t('alerts.lastFailed', { when: fmtWhen(d.lastSentAt), error: d.lastError ?? '' })
                      : t('alerts.lastSent', { when: fmtWhen(d.lastSentAt) })}
                  </p>
                )}
                {tested && (
                  <p className={`mt-1 text-[0.75rem] ${tested.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                    {tested.ok ? t('alerts.testSent') : tested.removed ? t('alerts.phones.removedByApple') : t('alerts.testFailed', { error: tested.error ?? '' })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Toggle
                  checked={d.enabled}
                  onChange={value => update.mutate({ id: d.id, patch: { enabled: value } })}
                  disabled={update.isPending && update.variables?.id === d.id}
                  label={t('alerts.enabledLabel', { name: d.name })}
                />
                <button onClick={() => test.mutate(d.id)} disabled={busy} title={t('alerts.test')} className={`${btn} ${neutral}`}>
                  <Send className={`w-4 h-4 ${test.isPending && test.variables === d.id ? 'animate-pulse' : ''}`} />
                  <span className="hidden sm:inline">{t('alerts.test')}</span>
                </button>
                <button
                  onClick={() => setDraft({ id: d.id, name: d.name, events: d.events, details: { ...NO_ALERT_DETAILS, ...d.details }, error: null })}
                  disabled={busy}
                  title={t('alerts.edit')}
                  aria-label={t('alerts.phones.editLabel', { name: d.name })}
                  className={`${btn} ${neutral}`}
                ><Pencil className="w-4 h-4" /></button>
                <button
                  onClick={() => setConfirmingId(d.id)}
                  disabled={busy}
                  title={t('alerts.delete')}
                  aria-label={t('alerts.delete')}
                  className={`${btn} ${isDark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-700'}`}
                ><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
            {confirmingId === d.id && (
              <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-50 text-slate-700'}`}>
                <p>{t('alerts.phones.removeConfirm', { name: d.name })}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => remove.mutate(d.id)}
                    disabled={remove.isPending}
                    className={`${btn} ${isDark ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30' : 'bg-red-600 text-white hover:bg-red-700'}`}
                  >{t('alerts.delete')}</button>
                  <button onClick={() => setConfirmingId(null)} className={`${btn} ${neutral}`}>{t('alerts.cancel')}</button>
                </div>
              </div>
            )}
          </li>
        );
      })}
      {draft && (
        <Modal
          isOpen
          onClose={() => { if (!saveDraft.isPending) setDraft(null); }}
          title={t('alerts.phones.editTitle', { name: draft.name })}
          className={`relative w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
        >
          <div className={`px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>{t('alerts.phones.editTitle', { name: draft.name })}</h2>
          </div>
          <div className="px-6 py-5 space-y-5 overflow-y-auto">
            <label className="block">
              <span className={`text-xs font-medium ${subtle}`}>{t('alerts.nameLabel')}</span>
              <input
                value={draft.name}
                maxLength={100}
                disabled={saveDraft.isPending}
                onChange={e => setDraft({ ...draft, name: e.target.value, error: null })}
                className={`${getInputClass(isDark)} w-full mt-1`}
              />
            </label>
            <AlertEventChoices
              isDark={isDark}
              events={draft.events}
              details={draft.details}
              disabled={saveDraft.isPending}
              onChange={next => setDraft({ ...draft, events: next.events, details: next.details, error: null })}
            />
          </div>
          <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <p className="min-w-0 text-xs text-red-500">{draft.error}</p>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setDraft(null)} disabled={saveDraft.isPending} className={`${btn} ${neutral}`}>{t('alerts.cancel')}</button>
              <button
                onClick={() => saveDraft.mutate(draft)}
                disabled={saveDraft.isPending || draft.name.trim().length === 0}
                className={`${btn} bg-accent-500 text-white hover:bg-accent-600`}
              >{t('alerts.save')}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
