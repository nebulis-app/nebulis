import { Coffee, ExternalLink, Mail } from 'lucide-react';
import { Sec } from './SettingsUI';
import qrCode from '../../assets/about/buy-me-a-coffee-qr.svg';

const COFFEE_URL = 'https://buymeacoffee.com/brent873';
const SUPPORT_EMAIL = 'support@nebulis.app';

export function AboutSection({ isDark }: { isDark: boolean }) {
  return (
    <>
      <Sec title="About Nebulis" isDark={isDark}>
        <div className="p-5 space-y-4">
          <p className={`text-[13.5px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            I've always loved astronomy and astrophotography. In 2023 I bought a Seestar, and quickly
            ran into a wall: getting images off the device and organized was a slog of manual file
            copying and guesswork. I wrote a few scripts to handle it for myself, and those scripts
            kept growing until they turned into a full app.
          </p>
          <p className={`text-[13.5px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            Nebulis is that app. It does the tedious part, pulling images off your telescope,
            organizing them, and matching them against catalogs, so you can spend more time observing
            and less time managing files.
          </p>
          <div>
            <p className={`text-[13px] font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Brent, creator of Nebulis
            </p>
            <a
              href="https://nebulis.app"
              target="_blank"
              rel="noopener noreferrer"
              className={`block text-[13px] font-medium mt-0.5 ${isDark ? 'text-accent-400 hover:underline' : 'text-accent-700 hover:underline'}`}
            >
              nebulis.app
            </a>
          </div>
        </div>
      </Sec>

      <Sec title="Feedback" isDark={isDark}>
        <div className="p-5 flex items-center gap-3">
          <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${
            isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-700'
          }`}>
            <Mail className="w-4 h-4" />
          </div>
          <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            Found a bug, or have an idea for a feature? Email{' '}
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
        title="Support Nebulis"
        description="Nebulis is free and built in my spare time. If it's useful to you, a coffee is always appreciated."
        isDark={isDark}
      >
        <div className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <img
            src={qrCode}
            alt="QR code to Buy Me a Coffee page"
            className={`w-28 h-28 rounded-lg border shrink-0 ${isDark ? 'border-slate-700 bg-white p-1.5' : 'border-slate-200 bg-white p-1.5'}`}
          />
          <div className="min-w-0">
            <p className={`text-[13px] mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Scan the code, or use the link below.
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
              Buy me a coffee
              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
            </a>
          </div>
        </div>
      </Sec>
    </>
  );
}
