import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MapPin, CheckCircle2, AlertCircle } from 'lucide-react';
import { updateSettings } from '../lib/api/settings';

/** Empty-state prompt shown on Planner / Forecast when the observer location
 *  isn't set. Detects via the browser geolocation API and persists to app
 *  settings — so any page reading `settings.latitude/longitude` updates. */
export function LocationPrompt({
  isDark,
  isNight,
  isSpace,
  subText,
  description = 'The target planner needs your latitude and longitude to calculate object visibility.',
  invalidateKeys = [],
}: {
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  subText: string;
  description?: string;
  /** Extra query keys to invalidate after saving (page-specific data). */
  invalidateKeys?: readonly (readonly unknown[])[];
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'detecting' | 'saving' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  function handleDetect() {
    if (!navigator.geolocation) {
      setStatus('error');
      setErrorMsg('Geolocation is not supported by this browser.');
      return;
    }
    // Geolocation only works on https:// or http://localhost. If the page was
    // opened over a LAN IP or .local hostname, the browser silently rejects
    // the request with POSITION_UNAVAILABLE, which is opaque without context.
    if (!window.isSecureContext) {
      setStatus('error');
      setErrorMsg(
        `Geolocation needs a secure connection. You opened this page at "${window.location.host}" over HTTP. ` +
        `Use http://localhost, or enter coordinates manually in Settings.`,
      );
      return;
    }
    setStatus('detecting');
    setErrorMsg('');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        setStatus('saving');
        try {
          await updateSettings({ latitude: lat, longitude: lon });
          await queryClient.invalidateQueries({ queryKey: ['settings'] });
          // Always invalidate forecast and planner so both pages update when location changes
          await queryClient.invalidateQueries({ queryKey: ['forecast'] });
          await queryClient.invalidateQueries({ queryKey: ['planner-tonight'] });
          for (const key of invalidateKeys) {
            await queryClient.invalidateQueries({ queryKey: key });
          }
          setStatus('success');
        } catch (e) {
          setStatus('error');
          setErrorMsg(e instanceof Error ? e.message : 'Failed to save location.');
        }
      },
      (err) => {
        setStatus('error');
        const isMac = /Mac/i.test(navigator.platform);
        setErrorMsg(
          err.code === 1
            ? 'Location access denied. Allow it in your browser, or set coordinates manually in Settings.'
            : err.code === 2
              ? isMac
                ? 'Location unavailable. Check System Settings → Privacy & Security → Location Services is on for your browser, or enter coordinates manually in Settings.'
                : 'Location unavailable. Check that your OS has location services enabled for this browser, or enter coordinates manually in Settings.'
              : 'Location request timed out. Try again, or enter coordinates manually in Settings.',
        );
      },
      { timeout: 15000, maximumAge: 300000, enableHighAccuracy: false },
    );
  }

  const detecting = status === 'detecting' || status === 'saving';

  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <MapPin className={`w-12 h-12 ${subText}`} />
      <h2 className={`text-xl font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>Location not set</h2>
      <p className={`max-w-md ${subText}`}>
        {description}
      </p>
      <button
        type="button"
        onClick={handleDetect}
        disabled={detecting}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
          isNight ? 'bg-red-950/40 text-red-400 hover:bg-red-950/60'
            : isSpace ? 'bg-violet-900/30 text-violet-300 hover:bg-violet-900/50'
              : 'bg-accent-600 text-white hover:bg-accent-700'
        }`}
      >
        <MapPin className="w-4 h-4" />
        {status === 'detecting' ? 'Detecting…'
          : status === 'saving' ? 'Saving…'
            : 'Use current location'}
      </button>
      {status === 'success' && (
        <span className="text-sm text-emerald-500 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" /> Location saved
        </span>
      )}
      {status === 'error' && (
        <span className="text-sm text-red-400 flex items-center gap-1.5 max-w-md">
          <AlertCircle className="w-4 h-4 shrink-0" /> {errorMsg}
        </span>
      )}
      <Link to="/settings" className={`text-xs ${subText} hover:underline`}>
        Or set coordinates manually in Settings
      </Link>
    </div>
  );
}
