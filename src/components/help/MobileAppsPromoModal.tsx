import { X, Smartphone, Tv, Mail } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { MOBILE_PROMO_DISMISSED_KEY, MOBILE_PROMO_SESSION_KEY } from '../../lib/mobilePromo';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function MobileAppsPromoModal({ isOpen, onClose }: Props) {
  const { isDark } = useTheme();

  function dismiss() {
    localStorage.setItem(MOBILE_PROMO_DISMISSED_KEY, 'true');
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
      title="Nebulis Mobile Apps"
      className="w-full max-w-md"
    >
      <div className={`rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${divider}`}>
          <div>
            <h2 className={`text-base font-bold ${heading}`}>Nebulis on Mobile</h2>
            <p className={`text-xs mt-0.5 ${muted}`}>Take your library anywhere</p>
          </div>
          <button
            onClick={remindLater}
            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <p className={`text-sm leading-relaxed ${body}`}>
            Thank you for using Nebulis. I believe your images and data belong to you, which is why I built this as a free, secure, self-hosted solution. Your library stays on your hardware, no accounts, no subscriptions, and no data leaving your network.
          </p>
          <p className={`text-sm leading-relaxed ${body}`}>
            The mobile apps let you browse your library on the go, or pull it up on your TV (Apple TV). I charge a small one-time fee ($4.99) to help cover ongoing development costs on those platforms.
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
                <div className={`text-sm font-semibold ${heading}`}>iPhone, iPad + Apple TV</div>
                <div className={`text-xs mt-0.5 ${muted}`}>Download on the App Store</div>
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
                <div className={`text-sm font-semibold ${heading}`}>Android</div>
                <div className={`text-xs mt-0.5 ${muted}`}>Get it on Google Play</div>
              </div>
            </a>
          </div>

          {/* Support */}
          <div className={`flex items-start gap-3 pt-1 pb-1 text-sm ${muted}`}>
            <Mail className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Report issues or request features:{' '}
              <a
                href="mailto:support@nebulis.app"
                className={`font-medium underline underline-offset-2 ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-700 hover:text-accent-600'}`}
              >
                support@nebulis.app
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
            Remind me later
          </button>
          <button
            onClick={dismiss}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
          >
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
}
