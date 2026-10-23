import { useState } from 'react';
import { leadLabel } from './alertLead';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, Plus, Pencil, Trash2, Send, CheckCircle2, AlertTriangle, Eye, Smartphone, Droplets } from 'lucide-react';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_EVENTS,
  ALERT_LANGUAGES,
  NO_ALERT_DETAILS,
  createAlertChannel,
  deleteAlertChannel,
  getAlerts,
  previewClearNight,
  sendClearNightToPhones,
  sendDewWarningToPhones,
  testAlertChannel,
  updateAlertChannel,
  updateAlertConfig,
  type AlertChannel,
  type AlertChannelKind,
  type AlertConfig,
  type AlertDetails,
  type AlertEventType,
  type ClearNightCheck,
  type PhoneSampleResult,
} from '../../lib/api/alerts';
import { activeLocale } from '../../lib/formatLocale';
import { Modal } from '../ui/Modal';
import { Row, Sec, Toggle, getInputClass } from './SettingsUI';
import { AlertPhoneRows } from './AlertPhones';
import { AlertEventChoices } from './AlertEventChoices';

/** The add/edit dialog's working copy. `url` / `secret` empty on an edit
 *  means "keep what is stored" (the server never sends them back). */
interface ChannelDraft {
  id: string | null;
  name: string;
  kind: AlertChannelKind;
  url: string;
  secret: string;
  clearSecret: boolean;
  hasSecret: boolean;
  urlPreview: string;
  events: AlertEventType[];
  details: AlertDetails;
  error: string | null;
}

const MIN_CLEAR_CHOICES = [2, 3, 4, 5, 6];
const CLOUD_CHOICES = [10, 20, 30, 45, 60];
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español', nl: 'Nederlands' };

const ALERTS_KEY = ['alerts'];

/**
 * Settings → Alerts: where Nebulis sends what it notices on its own, which
 * events go where, and the evening clear-night check.
 */
export function AlertsSection({ isDark }: { isDark: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ALERTS_KEY, queryFn: getAlerts, staleTime: 15_000 });
  const channels = data?.channels ?? [];
  const devices = data?.devices ?? [];

  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; error: string | null }>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClearNightCheck | null>(null);
  const [phoneSample, setPhoneSample] = useState<PhoneSampleResult | null>(null);
  const [dewSample, setDewSample] = useState<PhoneSampleResult | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
  const fail = (err: unknown) => setActionError(err instanceof Error ? err.message : t('alerts.actionFailed'));

  const save = useMutation({
    mutationFn: (d: ChannelDraft) => {
      const common = { name: d.name.trim(), kind: d.kind, events: d.events, details: d.details };
      if (d.id === null) {
        return createAlertChannel({ ...common, url: d.url.trim(), secret: d.kind === 'webhook' && d.secret ? d.secret : null });
      }
      return updateAlertChannel(d.id, {
        ...common,
        ...(d.url.trim() ? { url: d.url.trim() } : {}),
        ...(d.kind !== 'webhook' || d.clearSecret ? { secret: null } : d.secret ? { secret: d.secret } : {}),
      });
    },
    onSuccess: () => { setDraft(null); void refresh(); },
    onError: (err, d) => setDraft(cur => (cur && cur.id === d.id
      ? { ...cur, error: err instanceof Error ? err.message : t('alerts.saveFailed') }
      : cur)),
  });
  const toggle = useMutation({
    mutationFn: (c: AlertChannel) => updateAlertChannel(c.id, { enabled: !c.enabled }),
    onMutate: () => setActionError(null),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAlertChannel(id),
    onMutate: () => setActionError(null),
    onSuccess: () => { setConfirmingId(null); void refresh(); },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: (id: string) => testAlertChannel(id),
    onMutate: () => setActionError(null),
    onSuccess: (res, id) => { setTests(prev => ({ ...prev, [id]: { ok: res.ok, error: res.error } })); void refresh(); },
    onError: fail,
  });
  const config = useMutation({
    mutationFn: updateAlertConfig,
    onMutate: () => setActionError(null),
    onSuccess: saved => queryClient.setQueryData(ALERTS_KEY, data ? { ...data, config: saved } : data),
    onError: fail,
  });
  const sendToPhones = useMutation({
    mutationFn: sendClearNightToPhones,
    onMutate: () => setPhoneSample(null),
    onSuccess: setPhoneSample,
    onError: fail,
  });
  const sendDew = useMutation({
    mutationFn: sendDewWarningToPhones,
    onMutate: () => setDewSample(null),
    onSuccess: setDewSample,
    onError: fail,
  });
  const runPreview = useMutation({
    mutationFn: previewClearNight,
    onSuccess: setPreview,
    onError: fail,
  });

  const openAdd = () => {
    save.reset();
    // Default the message language to the UI language the first time.
    if (channels.length === 0 && data && (ALERT_LANGUAGES as readonly string[]).includes(i18n.language.slice(0, 2))
      && data.config.language !== i18n.language.slice(0, 2)) {
      config.mutate({ language: i18n.language.slice(0, 2) as AlertConfig['language'] });
    }
    setDraft({
      id: null, name: '', kind: 'ntfy', url: '', secret: '', clearSecret: false, hasSecret: false, urlPreview: '',
      events: ['night.clear', 'import.finished', 'import.failed'], details: NO_ALERT_DETAILS, error: null,
    });
  };
  const openEdit = (c: AlertChannel) => {
    save.reset();
    setDraft({
      id: c.id, name: c.name, kind: c.kind, url: '', secret: '', clearSecret: false, hasSecret: c.hasSecret,
      urlPreview: c.urlPreview, events: c.events, details: { ...NO_ALERT_DETAILS, ...c.details }, error: null,
    });
  };

  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const neutral = isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const faint = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const selectCls = `${getInputClass(isDark)} !w-auto !py-1.5 !px-3`;
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString(activeLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  const fmtClock = (iso: string, tz: string) => {
    try {
      return new Intl.DateTimeFormat(activeLocale(), { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch {
      return iso.slice(11, 16);
    }
  };

  const describeCheck = (c: ClearNightCheck): string => {
    if (!c.result) return t(`alerts.clearNight.reason.${c.reason}`);
    const r = c.result;
    const summary = t('alerts.clearNight.summary', {
      clear: r.clearHours, dark: r.darkHours, start: fmtClock(r.longestStart, r.timeZone), end: fmtClock(r.longestEnd, r.timeZone),
      moon: r.moonIllumination,
    });
    if (c.reason === 'preview') return summary;
    return `${summary} — ${t(`alerts.clearNight.reason.${c.reason}`)}`;
  };

  const cfg = data?.config;
  const clearNightListeners = channels.filter(c => c.enabled && c.events.includes('night.clear')).length
    + devices.filter(d => d.enabled && d.events.includes('night.clear')).length;

  return (
    <>
      <Sec
        title={t('alerts.title')}
        description={t('alerts.description')}
        isDark={isDark}
        actions={(
          <button onClick={openAdd} className={`${btn} bg-accent-500 text-white hover:bg-accent-600`}>
            <Plus className="w-4 h-4" /> {t('alerts.add')}
          </button>
        )}
      >
        <div className="px-5 py-5 space-y-4">
          {(actionError || error) && (
            <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
              {actionError ?? (error instanceof Error ? error.message : t('alerts.loadFailed'))}
            </div>
          )}

          {isLoading ? (
            <p className={`text-[0.8125rem] ${subtle}`}>{t('alerts.loading')}</p>
          ) : channels.length + devices.length === 0 ? (
            <div className={`rounded-lg border border-dashed px-4 py-6 text-center ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
              <Bell className={`w-6 h-6 mx-auto mb-2 ${faint}`} />
              <p className={`text-[0.8125rem] ${strong}`}>{t('alerts.empty')}</p>
              <p className={`mt-1 text-[0.75rem] ${subtle}`}>{t('alerts.emptyHint')}</p>
            </div>
          ) : (
            <ul className={`rounded-lg border divide-y ${isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-100'}`}>
              <AlertPhoneRows isDark={isDark} devices={devices} onChanged={() => void refresh()} />
              {channels.map(c => {
                const busy = (test.isPending && test.variables === c.id) || (remove.isPending && remove.variables === c.id);
                const tested = tests[c.id];
                return (
                  <li key={c.id} className="px-3.5 py-3 space-y-2">
                    <div className="flex items-start gap-3">
                      {c.enabled
                        ? <Bell className={`w-4 h-4 mt-0.5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
                        : <BellOff className={`w-4 h-4 mt-0.5 shrink-0 ${faint}`} />}
                      <div className="min-w-0 flex-1">
                        <p className={`text-[0.8125rem] font-medium ${strong}`}>
                          {c.name}
                          <span className={`ml-2 text-[0.6875rem] font-normal ${faint}`}>{t(`alerts.kind.${c.kind}`)}</span>
                        </p>
                        <p className={`mt-0.5 text-[0.6875rem] font-mono break-all ${faint}`}>{c.urlPreview}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {c.events.length === 0 ? (
                            <span className={`text-[0.7188rem] ${subtle}`}>{t('alerts.noEvents')}</span>
                          ) : ALERT_EVENTS.filter(e => c.events.includes(e)).map(e => (
                            <span
                              key={e}
                              className={`rounded-full px-2 py-0.5 text-[0.6562rem] font-medium ${isDark ? 'bg-accent-500/10 text-accent-300' : 'bg-accent-50 text-accent-700'}`}
                            >
                              {t(`alerts.event.${e}.short`)}
                            </span>
                          ))}
                        </div>
                        {c.events.includes('night.dew') && (
                          <p className={`mt-1.5 text-[0.7188rem] ${subtle}`}>{t('alerts.detail.dewRow', { time: leadLabel(c.details?.dewLeadMinutes ?? 60, t) })}</p>
                        )}
                        {c.lastSentAt && (
                          <p className={`mt-1.5 inline-flex items-center gap-1.5 text-[0.7188rem] ${
                            c.lastStatus === 'error' ? (isDark ? 'text-amber-300' : 'text-amber-700') : subtle
                          }`}>
                            {c.lastStatus === 'error'
                              ? <AlertTriangle className="w-3.5 h-3.5" />
                              : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                            {c.lastStatus === 'error'
                              ? t('alerts.lastFailed', { when: fmtWhen(c.lastSentAt), error: c.lastError ?? '' })
                              : t('alerts.lastSent', { when: fmtWhen(c.lastSentAt) })}
                          </p>
                        )}
                        {tested && (
                          <p className={`mt-1 text-[0.75rem] ${tested.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                            {tested.ok ? t('alerts.testSent') : t('alerts.testFailed', { error: tested.error ?? '' })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Toggle
                          checked={c.enabled}
                          onChange={() => toggle.mutate(c)}
                          disabled={toggle.isPending && toggle.variables?.id === c.id}
                          label={t('alerts.enabledLabel', { name: c.name })}
                        />
                        <button
                          onClick={() => test.mutate(c.id)}
                          disabled={busy}
                          title={t('alerts.test')}
                          className={`${btn} ${neutral}`}
                        >
                          <Send className={`w-4 h-4 ${test.isPending && test.variables === c.id ? 'animate-pulse' : ''}`} />
                          <span className="hidden sm:inline">{t('alerts.test')}</span>
                        </button>
                        <button
                          onClick={() => openEdit(c)}
                          disabled={busy}
                          title={t('alerts.edit')}
                          aria-label={t('alerts.edit')}
                          className={`${btn} ${neutral}`}
                        ><Pencil className="w-4 h-4" /></button>
                        <button
                          onClick={() => setConfirmingId(c.id)}
                          disabled={busy}
                          title={t('alerts.delete')}
                          aria-label={t('alerts.delete')}
                          className={`${btn} ${isDark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300' : 'bg-red-50 hover:bg-red-100 text-red-700'}`}
                        ><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                    {confirmingId === c.id && (
                      <div className={`rounded-lg px-3.5 py-3 text-[0.75rem] ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-50 text-slate-700'}`}>
                        <p>{t('alerts.deleteConfirm', { name: c.name })}</p>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => remove.mutate(c.id)}
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
            </ul>
          )}
        </div>
      </Sec>

      {cfg && (
        <Sec title={t('alerts.clearNight.title')} description={t('alerts.clearNight.description')} isDark={isDark}>
          <Row label={t('alerts.clearNight.checkTime')} description={t('alerts.clearNight.checkTimeHelp')} isDark={isDark}>
            <input
              type="time"
              min="12:00"
              value={cfg.clearNight.checkTime}
              onChange={e => { if (e.target.value) config.mutate({ clearNight: { checkTime: e.target.value } }); }}
              className={selectCls}
              aria-label={t('alerts.clearNight.checkTime')}
            />
          </Row>
          <Row label={t('alerts.clearNight.minClearHours')} description={t('alerts.clearNight.minClearHoursHelp')} isDark={isDark}>
            <select
              value={cfg.clearNight.minClearHours}
              onChange={e => config.mutate({ clearNight: { minClearHours: Number(e.target.value) } })}
              className={selectCls}
              aria-label={t('alerts.clearNight.minClearHours')}
            >
              {[...new Set([...MIN_CLEAR_CHOICES, cfg.clearNight.minClearHours])].sort((a, b) => a - b).map(h => (
                <option key={h} value={h}>{t('alerts.clearNight.hours', { count: h })}</option>
              ))}
            </select>
          </Row>
          <Row label={t('alerts.clearNight.maxCloud')} description={t('alerts.clearNight.maxCloudHelp')} isDark={isDark}>
            <select
              value={cfg.clearNight.maxCloudCover}
              onChange={e => config.mutate({ clearNight: { maxCloudCover: Number(e.target.value) } })}
              className={selectCls}
              aria-label={t('alerts.clearNight.maxCloud')}
            >
              {[...new Set([...CLOUD_CHOICES, cfg.clearNight.maxCloudCover])].sort((a, b) => a - b).map(p => (
                <option key={p} value={p}>{t('alerts.clearNight.cloudPct', { pct: p })}</option>
              ))}
            </select>
          </Row>
          <Row label={t('alerts.language')} description={t('alerts.languageHelp')} isDark={isDark}>
            <select
              value={cfg.language}
              onChange={e => config.mutate({ language: e.target.value as AlertConfig['language'] })}
              className={selectCls}
              aria-label={t('alerts.language')}
            >
              {ALERT_LANGUAGES.map(l => <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>)}
            </select>
          </Row>
          <div className="px-5 py-4 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => runPreview.mutate()} disabled={runPreview.isPending} className={`${btn} ${neutral}`}>
                <Eye className="w-4 h-4" /> {t('alerts.clearNight.preview')}
              </button>
              {devices.some(d => d.enabled) && (
                <button onClick={() => sendToPhones.mutate()} disabled={sendToPhones.isPending} className={`${btn} ${neutral}`} title={t('alerts.clearNight.sendToPhonesHelp')}>
                  <Smartphone className={`w-4 h-4 ${sendToPhones.isPending ? 'animate-pulse' : ''}`} /> {t('alerts.clearNight.sendToPhones')}
                </button>
              )}
              {devices.some(d => d.enabled && d.events.includes('night.dew')) && (
                <button onClick={() => sendDew.mutate()} disabled={sendDew.isPending} className={`${btn} ${neutral}`} title={t('alerts.clearNight.sendDewHelp')}>
                  <Droplets className={`w-4 h-4 ${sendDew.isPending ? 'animate-pulse' : ''}`} /> {t('alerts.clearNight.sendDew')}
                </button>
              )}
              <span className={`text-[0.75rem] ${subtle}`}>
                {clearNightListeners === 0
                  ? t('alerts.clearNight.noListener')
                  : t('alerts.clearNight.listeners', { count: clearNightListeners })}
              </span>
            </div>
            {data?.nextClearNightCheck && clearNightListeners > 0 && (
              <p className={`text-[0.75rem] ${subtle}`}>
                {t(`alerts.clearNight.next.${data.nextClearNightCheck.when}`, {
                  time: fmtClock(data.nextClearNightCheck.at, data.nextClearNightCheck.timeZone),
                  hours: cfg.clearNight.minClearHours,
                })}
              </p>
            )}
            {phoneSample && (
              <div className="space-y-1" role="status">
                {phoneSample.check.result === null ? (
                  <p className={`text-[0.7812rem] ${strong}`}>{t(`alerts.clearNight.reason.${phoneSample.check.reason}`)}</p>
                ) : phoneSample.sent > 0 && (
                  <p className="text-[0.7812rem] text-emerald-500">{t('alerts.clearNight.sentToPhones', { count: phoneSample.sent })}</p>
                )}
                {phoneSample.sent > 0 && devices.filter(d => d.enabled).every(d => !d.details?.plan && !d.details?.dew) && (
                  <p className={`text-[0.75rem] ${subtle}`}>{t('alerts.clearNight.phoneNoExtras')}</p>
                )}
                {phoneSample.failed.map(f => (
                  <p key={f.name} className="text-[0.7812rem] text-red-500">{t('alerts.clearNight.phoneFailed', { name: f.name, error: f.error })}</p>
                ))}
              </div>
            )}
            {dewSample && (
              <div className="space-y-1" role="status">
                {dewSample.sent > 0 && <p className="text-[0.7812rem] text-emerald-500">{t('alerts.clearNight.sentDew', { count: dewSample.sent })}</p>}
                {dewSample.sent > 0 && dewSample.sample && <p className={`text-[0.75rem] ${subtle}`}>{t('alerts.clearNight.dewSample')}</p>}
                {dewSample.failed.map(f => (
                  <p key={f.name} className="text-[0.7812rem] text-red-500">{t('alerts.clearNight.phoneFailed', { name: f.name, error: f.error })}</p>
                ))}
              </div>
            )}
            {preview && (
              <p className={`text-[0.7812rem] ${strong}`}>{t('alerts.clearNight.tonight')} {describeCheck(preview)}</p>
            )}
            {data?.lastClearNightCheck && (
              <p className={`text-[0.75rem] ${subtle}`}>
                {t('alerts.clearNight.lastCheck', { when: fmtWhen(data.lastClearNightCheck.checkedAt) })} {describeCheck(data.lastClearNightCheck)}
              </p>
            )}
          </div>
        </Sec>
      )}

      {draft && (
        <Modal
          isOpen
          onClose={() => { if (!save.isPending) setDraft(null); }}
          title={draft.id ? t('alerts.editTitle') : t('alerts.addTitle')}
          className={`relative w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${
            isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className={`px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {draft.id ? t('alerts.editTitle') : t('alerts.addTitle')}
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            <div>
              <span className={`text-xs font-medium ${subtle}`}>{t('alerts.kindLabel')}</span>
              <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {ALERT_CHANNEL_KINDS.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDraft({ ...draft, kind: k, error: null })}
                    disabled={save.isPending}
                    className={`px-3 py-2 rounded-lg text-[0.7812rem] font-medium border transition-colors ${
                      draft.kind === k
                        ? 'bg-accent-500 text-white border-accent-500'
                        : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {t(`alerts.kind.${k}`)}
                  </button>
                ))}
              </div>
              <p className={`mt-2 text-[0.75rem] leading-relaxed ${subtle}`}>{t(`alerts.kindHelp.${draft.kind}`)}</p>
            </div>

            <label className="block">
              <span className={`text-xs font-medium ${subtle}`}>{t('alerts.nameLabel')}</span>
              <input
                value={draft.name}
                maxLength={100}
                placeholder={t(`alerts.namePlaceholder.${draft.kind}`)}
                disabled={save.isPending}
                onChange={e => setDraft({ ...draft, name: e.target.value, error: null })}
                className={`${getInputClass(isDark)} w-full mt-1`}
              />
            </label>

            <label className="block">
              <span className={`text-xs font-medium ${subtle}`}>{t('alerts.urlLabel')}</span>
              <input
                value={draft.url}
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={draft.id ? draft.urlPreview : t(`alerts.urlPlaceholder.${draft.kind}`)}
                disabled={save.isPending}
                onChange={e => setDraft({ ...draft, url: e.target.value, error: null })}
                className={`${getInputClass(isDark)} w-full mt-1 font-mono !text-[0.7812rem]`}
              />
              {draft.id && <span className={`mt-1 block text-[0.7188rem] ${faint}`}>{t('alerts.urlKeep')}</span>}
            </label>

            {draft.kind === 'webhook' && (
              <label className="block">
                <span className={`text-xs font-medium ${subtle}`}>{t('alerts.secretLabel')}</span>
                <input
                  value={draft.secret}
                  type="password"
                  autoComplete="new-password"
                  placeholder={draft.hasSecret && !draft.clearSecret ? '••••••••' : ''}
                  disabled={save.isPending || draft.clearSecret}
                  onChange={e => setDraft({ ...draft, secret: e.target.value, error: null })}
                  className={`${getInputClass(isDark)} w-full mt-1`}
                />
                <span className={`mt-1 block text-[0.7188rem] ${faint}`}>{t('alerts.secretHelp')}</span>
                {draft.hasSecret && (
                  <label className={`mt-1.5 flex items-center gap-2 text-[0.75rem] ${subtle}`}>
                    <input
                      type="checkbox"
                      checked={draft.clearSecret}
                      onChange={e => setDraft({ ...draft, clearSecret: e.target.checked, secret: '' })}
                      className="accent-amber-500"
                    />
                    {t('alerts.secretClear')}
                  </label>
                )}
              </label>
            )}

            <AlertEventChoices
              isDark={isDark}
              events={draft.events}
              details={draft.details}
              disabled={save.isPending}
              onChange={next => setDraft({ ...draft, events: next.events, details: next.details, error: null })}
            />
          </div>

          <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <p className="min-w-0 text-xs text-red-500">{draft.error}</p>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setDraft(null)} disabled={save.isPending} className={`${btn} ${neutral}`}>
                {t('alerts.cancel')}
              </button>
              <button
                onClick={() => save.mutate(draft)}
                disabled={save.isPending || draft.name.trim().length === 0 || (draft.id === null && draft.url.trim().length === 0)}
                className={`${btn} bg-accent-500 text-white hover:bg-accent-600`}
              >
                {t('alerts.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
