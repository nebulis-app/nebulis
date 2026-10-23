import { useTranslation } from 'react-i18next';
import { Coffee, ExternalLink, Mail } from 'lucide-react';
import { Sec } from './SettingsUI';
import { DataSourcesSection } from './DataSourcesSection';
import qrCode from '../../assets/about/buy-me-a-coffee-qr.svg';

const COFFEE_URL = 'https://buymeacoffee.com/brent873';
const SUPPORT_EMAIL = 'support@nebulis.app';

export function AboutSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <Sec title={t('about.title')} isDark={isDark}>
        <div className="p-5 space-y-4">
          <p className={`text-[0.8438rem] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            {t('about.story1')}
          </p>
          <p className={`text-[0.8438rem] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            {t('about.story2')}
          </p>
          <div>
            <p className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {t('about.creatorByline')}
            </p>
            <a
              href="https://nebulis.app"
              target="_blank"
              rel="noopener noreferrer"
              className={`block text-[0.8125rem] font-medium mt-0.5 ${isDark ? 'text-accent-400 hover:underline' : 'text-accent-700 hover:underline'}`}
            >
              nebulis.app
            </a>
          </div>
        </div>
      </Sec>

      <Sec title={t('about.feedbackTitle')} isDark={isDark}>
        <div className="p-5 flex items-center gap-3">
          <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${
            isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-700'
          }`}>
            <Mail className="w-4 h-4" />
          </div>
          <p className={`text-[0.8125rem] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            {t('about.feedbackBefore')}{' '}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className={isDark ? 'text-accent-400 hover:underline' : 'text-accent-700 hover:underline'}
            >
              {SUPPORT_EMAIL}
            </a>.
          </p>
        </div>
      </Sec>

      <Sec
        title={t('about.supportTitle')}
        description={t('about.supportDescription')}
        isDark={isDark}
      >
        <div className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <img
            src={qrCode}
            alt={t('about.qrAlt')}
            className={`w-28 h-28 rounded-lg border shrink-0 ${isDark ? 'border-slate-700 bg-white p-1.5' : 'border-slate-200 bg-white p-1.5'}`}
          />
          <div className="min-w-0">
            <p className={`text-[0.8125rem] mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {t('about.scanOrLink')}
            </p>
            <a
              href={COFFEE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                isDark
                  ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20'
                  : 'bg-accent-50 text-accent-700 hover:bg-accent-100'
              }`}
            >
              <Coffee className="w-4 h-4" />
              {t('about.buyMeACoffee')}
              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
            </a>
          </div>
        </div>
      </Sec>

      <DataSourcesSection isDark={isDark} />
    </>
  );
}
