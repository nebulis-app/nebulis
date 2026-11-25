import { useTranslation } from 'react-i18next';
import { X, Smartphone, Tv, Mail } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { MOBILE_PROMO_DISMISSED_KEY, MOBILE_PROMO_SESSION_KEY } from '../../lib/mobilePromo';
import { setUiSetting } from '../../lib/uiSettings';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function MobileAppsPromoModal({ isOpen, onClose }: Props) {
  const { t } = useTranslation('help');
  const { isDark } = useTheme();

  function dismiss() {
    setUiSetting(MOBILE_PROMO_DISMISSED_KEY, 'true');
    onClose();
  }

  function remindLater() {
    sessionStorage.setItem(MOBILE_PROMO_SESSION_KEY, 'true');
    onClose();
  }

  const bg = isDark ? 'bg-slate-900' : 'bg-white';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const body = isDark ? 'text-slate-300' : 'text-slate-700';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  return (
    <Modal
      isOpen={isOpen}
      onClose={remindLater}
      title={t('mobileAppsPromo.title')}
      className="w-full max-w-md"
    >
      <div className={`rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${divider}`}>
          <div>
            <h2 className={`text-base font-bold ${heading}`}>{t('mobileAppsPromo.heading')}</h2>
            <p className={`text-xs mt-0.5 ${muted}`}>{t('mobileAppsPromo.subtitle')}</p>
          </div>
          <button
            onClick={remindLater}
            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label={t('mobileAppsPromo.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <p className={`text-sm leading-relaxed ${body}`}>
            {t('mobileAppsPromo.body1')}
          </p>
          <p className={`text-sm leading-relaxed ${body}`}>
            {t('mobileAppsPromo.body2')}
          </p>

          {/* App links */}
          <div className="space-y-2 pt-1">
            <a
              href="https://apps.apple.com/us/app/nebulis/id6769902885"
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                isDark
                  ? 'border-slate-700 hover:border-accent-500/60 hover:bg-slate-800/60'
                  : 'border-slate-200 hover:border-accent-500/40 hover:bg-slate-50'
              }`}
            >
              <div className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-xl ${isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-600'}`}>
                <Smartphone className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className={`text-sm font-semibold ${heading}`}>{t('mobileAppsPromo.appleLine1')}</div>
                <div className={`text-xs mt-0.5 ${muted}`}>{t('mobileAppsPromo.appleLine2')}</div>
              </div>
              <Tv className={`ml-auto w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=com.nebulis.app"
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                isDark
                  ? 'border-slate-700 hover:border-accent-500/60 hover:bg-slate-800/60'
                  : 'border-slate-200 hover:border-accent-500/40 hover:bg-slate-50'
              }`}
            >
              <div className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-xl ${isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-100 text-accent-600'}`}>
                <Smartphone className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className={`text-sm font-semibold ${heading}`}>{t('mobileAppsPromo.androidLine1')}</div>
                <div className={`text-xs mt-0.5 ${muted}`}>{t('mobileAppsPromo.androidLine2')}</div>
              </div>
            </a>
          </div>

          {/* Support */}
          <div className={`flex items-start gap-3 pt-1 pb-1 text-sm ${muted}`}>
            <Mail className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {t('mobileAppsPromo.supportLine')}{' '}
              <a
                href="mailto:support@nebulis.app"
                className={`font-medium underline underline-offset-2 ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-700 hover:text-accent-600'}`}
              >
                {t('mobileAppsPromo.supportEmail')}
              </a>
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${divider}`}>
          <button
            onClick={remindLater}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
          >
            {t('mobileAppsPromo.remindLater')}
          </button>
          <button
            onClick={dismiss}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
          >
            {t('mobileAppsPromo.gotIt')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
