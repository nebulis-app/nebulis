import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone, QrCode, Tv } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useClickOutside } from '../hooks/useClickOutside';
import { ConnectDeviceModal } from './settings/ConnectDeviceModal';
import { EnterCodeModal } from './settings/EnterCodeModal';

const IOS_APP_URL = 'https://apps.apple.com/us/app/nebulis/id6769902885';
const ANDROID_APP_URL = 'https://play.google.com/store/apps/details?id=com.nebulis.app';

/**
 * Nav-bar "Mobile" button — a popover with links to the iOS/Android apps plus
 * quick actions for the two device-pairing flows (QR for phones/tablets,
 * short code for Apple TV) that otherwise live buried in Settings > Devices.
 */
export function MobileMenu() {
  const { isDark, isNight, isSpace } = useTheme();
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showEnterCode, setShowEnterCode] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), { enabled: open, closeOnEscape: true });

  return (
    <div ref={ref} className="relative ml-1">
      <button
        onClick={() => setOpen(o => !o)}
        title={t('mobileMenu.title')}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium select-none transition-all ${
          open
            ? isNight
              ? 'bg-red-950/40 text-red-400'
              : isSpace
                ? 'bg-violet-900/30 text-violet-300'
                : isDark
                  ? 'bg-accent-500/20 text-accent-300'
                  : 'bg-accent-300 text-accent-700'
            : isNight
              ? 'bg-red-950/20 text-red-400 hover:bg-red-950/30'
              : isSpace
                ? 'bg-violet-900/15 text-violet-300 hover:bg-violet-900/25'
                : isDark
                  ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/15'
                  : 'bg-accent-100 text-accent-700 hover:bg-accent-200'
        }`}
      >
        <Smartphone className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline">{t('mobileMenu.mobile')}</span>
      </button>

      {open && (
        <div className={`absolute right-0 top-full mt-2 z-50 w-72 rounded-2xl border shadow-2xl overflow-hidden ${
          isNight
            ? 'bg-[#0a0000] border-[#2a0808]'
            : isSpace
              ? 'bg-[#0d0b1f] border-[#1e1a40]'
              : isDark
                ? 'bg-slate-900 border-slate-800'
                : 'bg-white border-slate-200'
        }`}>
          <div className={`px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider border-b ${
            isDark ? 'text-slate-500 border-slate-800' : 'text-slate-400 border-slate-100'
          }`}>
            {t('mobileMenu.connectYourDevice')}
          </div>

          <div className="p-2 space-y-1">
            <button
              type="button"
              onClick={() => { setShowConnect(true); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition ${
                isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
              }`}
            >
              <QrCode className={`w-5 h-5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
              <div className="min-w-0">
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t('mobileMenu.scanQrCode')}
                </p>
                <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('mobileMenu.connectPhoneOrTablet')}
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => { setShowEnterCode(true); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition ${
                isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
              }`}
            >
              <Tv className={`w-5 h-5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
              <div className="min-w-0">
                <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t('mobileMenu.enterCode')}
                </p>
                <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('mobileMenu.addAppleTv')}
                </p>
              </div>
            </button>
          </div>

          <div className={`px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider border-t ${
            isDark ? 'text-slate-500 border-slate-800' : 'text-slate-400 border-slate-100'
          }`}>
            {t('mobileMenu.getNebulisOnYourDevice')}
          </div>

          <div className="p-2 space-y-1">
            <a
              href={IOS_APP_URL}
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-3 px-2.5 py-2 rounded-xl transition ${
                isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
              }`}
            >
              <Smartphone className={`w-5 h-5 shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t('mobileMenu.iosDevices')}
                </p>
                <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('mobileMenu.downloadOnAppStore')}
                </p>
              </div>
            </a>
            <a
              href={ANDROID_APP_URL}
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-3 px-2.5 py-2 rounded-xl transition ${
                isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
              }`}
            >
              <Smartphone className={`w-5 h-5 shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t('mobileMenu.android')}
                </p>
                <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('mobileMenu.getItOnGooglePlay')}
                </p>
              </div>
            </a>
          </div>
        </div>
      )}

      {showConnect && <ConnectDeviceModal isDark={isDark} onClose={() => setShowConnect(false)} />}
      {showEnterCode && <EnterCodeModal isDark={isDark} onClose={() => setShowEnterCode(false)} />}
    </div>
  );
}
