import { useTranslation } from 'react-i18next';
import { ALERT_EVENTS, DEW_LEAD_CHOICES, type AlertDetails, type AlertEventType } from '../../lib/api/alerts';
import { getInputClass } from './SettingsUI';
import { leadLabel } from './alertLead';

const DETAILS = ['plan', 'dew'] as const;

/**
 * Which events one destination gets, and for the clear-night alert which extra lines it carries (tonight's plan, dew risk). The same choices
 * for a channel and for a phone, so both are set up the same way. The extras only show while "Clear night ahead" is ticked; their values are
 * kept if it is unticked and ticked again. The dew warning likewise shows how far ahead of the dew it should be sent, for this destination.
 */
export function AlertEventChoices({
  isDark, events, details, disabled, onChange,
}: {
  isDark: boolean;
  events: AlertEventType[];
  details: AlertDetails;
  disabled?: boolean;
  onChange: (next: { events: AlertEventType[]; details: AlertDetails }) => void;
}) {
  const { t } = useTranslation('settings');
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const faint = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <fieldset>
      <legend className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{t('alerts.eventsLabel')}</legend>
      <div className="mt-2 space-y-2.5">
        {ALERT_EVENTS.map(e => (
          <div key={e}>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={events.includes(e)}
                disabled={disabled}
                onChange={ev => onChange({ events: ev.target.checked ? [...events, e] : events.filter(x => x !== e), details })}
                className="mt-0.5 accent-amber-500"
              />
              <span>
                <span className={`block text-[0.8125rem] ${strong}`}>{t(`alerts.event.${e}.label`)}</span>
                <span className={`block text-[0.7188rem] ${faint}`}>{t(`alerts.event.${e}.help`)}</span>
              </span>
            </label>
            {e === 'night.dew' && events.includes('night.dew') && (
              <label className="mt-2 ml-6 flex flex-wrap items-center gap-2.5 border-l pl-3.5 border-slate-700/50">
                <span className={`text-[0.7812rem] ${strong}`}>{t('alerts.detail.leadLabel')}</span>
                <select
                  value={details.dewLeadMinutes}
                  disabled={disabled}
                  onChange={ev => onChange({ events, details: { ...details, dewLeadMinutes: Number(ev.target.value) } })}
                  className={`${getInputClass(isDark)} !w-auto !py-1 !px-2.5 !text-[0.7812rem]`}
                  aria-label={t('alerts.detail.leadLabel')}
                >
                  {[...new Set<number>([...DEW_LEAD_CHOICES, details.dewLeadMinutes])].sort((x, y) => x - y).map(m => (
                    <option key={m} value={m}>{t('alerts.detail.lead', { time: leadLabel(m, t) })}</option>
                  ))}
                </select>
              </label>
            )}
            {e === 'night.clear' && events.includes('night.clear') && (
              <div className="mt-2 ml-6 space-y-2 border-l pl-3.5 border-slate-700/50" role="group" aria-label={t('alerts.detail.group')}>
                {DETAILS.map(d => (
                  <label key={d} className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={details[d]}
                      disabled={disabled}
                      onChange={ev => onChange({ events, details: { ...details, [d]: ev.target.checked } })}
                      className="mt-0.5 accent-amber-500"
                    />
                    <span>
                      <span className={`block text-[0.7812rem] ${strong}`}>{t(`alerts.detail.${d}.label`)}</span>
                      <span className={`block text-[0.7188rem] ${faint}`}>{t(`alerts.detail.${d}.help`)}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
