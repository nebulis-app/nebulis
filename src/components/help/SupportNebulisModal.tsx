import { useTranslation } from 'react-i18next';
import { Coffee, ExternalLink, Heart, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { COFFEE_URL, markSupportAskSeen } from '../../lib/support';
import qrCode from '../../assets/about/buy-me-a-coffee-qr.svg';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * "Enjoying Nebulis?" Shown once, after the What's New popup. Opening the coffee link, the close
 * button, Escape and a backdrop click all count as having seen it, so it never comes back.
 *
 * Wide on purpose: the story reads on the left and the QR code sits beside it on a card, so the
 * ask is a single glance on a desktop and a short scroll on a phone, where it stacks.
 */
export function SupportNebulisModal({ isOpen, onClose }: Props) {
  const { t } = useTranslation('common');
  const { isDark } = useTheme();

  function finish() {
    markSupportAskSeen();
    onClose();
  }

  const bg = isDark ? 'bg-slate-900' : 'bg-white';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const body = isDark ? 'text-slate-300' : 'text-slate-700';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  const accentText = isDark ? 'text-accent-400' : 'text-accent-700';
  const hero = isDark
    ? 'bg-gradient-to-br from-accent-500/15 via-slate-900 to-slate-900'
    : 'bg-gradient-to-br from-accent-50 via-white to-white';
  const card = isDark ? 'bg-slate-800/50 border-slate-700/70' : 'bg-slate-50 border-slate-200';
  const note = isDark ? 'bg-accent-500/10 border-accent-500/20' : 'bg-accent-50 border-accent-100';

  return (
    <Modal isOpen={isOpen} onClose={finish} title={t('supportAsk.title')} className="w-full max-w-2xl">
      <div className={`rounded-2xl border shadow-xl overflow-hidden flex flex-col max-h-[90vh] ${bg} ${border}`}>
        <div className={`flex items-center gap-4 px-6 py-5 border-b ${divider} ${hero}`}>
          <div className={`shrink-0 flex items-center justify-center w-11 h-11 rounded-xl ${isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-700'}`}>
            <Coffee className="w-5 h-5" />
          </div>
          <h2 className={`flex-1 min-w-0 text-xl font-bold tracking-tight ${heading}`}>{t('supportAsk.title')}</h2>
          <button
            type="button"
            onClick={finish}
            className={`shrink-0 p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label={t('supportAsk.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-6 space-y-6">
          <p className={`text-base leading-relaxed font-medium ${heading}`}>{t('supportAsk.body1')}</p>

          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
            <div className="space-y-4">
              <p className={`text-sm leading-relaxed ${body}`}>{t('supportAsk.body2')}</p>
              <p className={`text-sm leading-relaxed ${body}`}>{t('supportAsk.body3')}</p>
            </div>

            <div className={`flex flex-col items-center gap-3 rounded-2xl border p-4 ${card}`}>
              <img
                src={qrCode}
                alt={t('supportAsk.qrAlt')}
                className="w-36 h-36 rounded-xl border border-slate-200 bg-white p-2"
              />
              <p className={`text-xs text-center leading-snug ${muted}`}>{t('supportAsk.scan')}</p>
              <a
                href={COFFEE_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={markSupportAskSeen}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors bg-accent-500 text-white hover:bg-accent-600"
              >
                <Coffee className="w-4 h-4" />
                {t('supportAsk.button')}
                <ExternalLink className="w-3.5 h-3.5 opacity-60" />
              </a>
            </div>
          </div>

          <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${note}`}>
            <Heart className={`w-4 h-4 mt-0.5 shrink-0 ${accentText}`} />
            <p className={`text-[0.8125rem] leading-relaxed ${body}`}>{t('supportAsk.freeNote')}</p>
          </div>

          <p className={`text-base font-semibold italic ${accentText}`}>{t('supportAsk.salutation')}</p>
        </div>

        <div className={`flex items-center justify-between gap-4 px-6 py-3 border-t ${divider}`}>
          <p className={`text-xs ${muted}`}>{t('supportAsk.onlyOnce')}</p>
          <button
            type="button"
            onClick={finish}
            className={`shrink-0 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {t('supportAsk.close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
