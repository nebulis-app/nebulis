import { useState } from 'react';
import {
  MapPin,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { getInputClass, getLabelClass, getHelperClass, getCardClass } from './SettingsUI';

export function LocationSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [detectStatus, setDetectStatus] = useState<'idle' | 'detecting' | 'success' | 'error'>('idle');
  const [detectError, setDetectError] = useState('');

  function detectLocation() {
    if (!navigator.geolocation) {
      setDetectStatus('error');
      setDetectError('Geolocation is not supported by this browser.');
      return;
    }
    setDetectStatus('detecting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        setForm(f => ({ ...f, latitude: lat, longitude: lon }));
        setDetectStatus('success');
      },
      (err) => {
        setDetectStatus('error');
        setDetectError(
          err.code === 1
            ? 'Location access denied - allow it in your browser and try again.'
            : err.code === 2
              ? 'Location unavailable. Try entering coordinates manually.'
              : 'Location request timed out.',
        );
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  }

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center gap-3 mb-5">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
          <MapPin className="w-5 h-5 text-teal-500" />
        </div>
        <div>
          <h2 className={`font-display text-[17px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Location &amp; Sky
          </h2>
          <p className={`text-[13px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Required for the Target Planner to calculate visibility
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Coordinates */}
        <div className={`${getCardClass(isDark)} space-y-5`}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Latitude</label>
              <input
                type="number"
                step="0.0001"
                min="-90"
                max="90"
                placeholder="e.g. 40.7128"
                className={inputClass}
                value={form.latitude ?? ''}
                onChange={e =>
                  setForm(f => ({
                    ...f,
                    latitude: e.target.value === '' ? null : parseFloat(e.target.value),
                  }))
                }
              />
              <p className={helperClass}>Decimal degrees, north positive</p>
            </div>
            <div>
              <label className={labelClass}>Longitude</label>
              <input
                type="number"
                step="0.0001"
                min="-180"
                max="180"
                placeholder="e.g. -74.0060"
                className={inputClass}
                value={form.longitude ?? ''}
                onChange={e =>
                  setForm(f => ({
                    ...f,
                    longitude: e.target.value === '' ? null : parseFloat(e.target.value),
                  }))
                }
              />
              <p className={helperClass}>Decimal degrees, east positive</p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={detectLocation}
              disabled={detectStatus === 'detecting'}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all duration-150 ${
                isDark
                  ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              <MapPin className="w-4 h-4" />
              {detectStatus === 'detecting' ? 'Detecting…' : 'Use current location'}
            </button>
            {detectStatus === 'success' && (
              <span className="text-sm text-emerald-500 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Location detected
              </span>
            )}
            {detectStatus === 'error' && (
              <span className="text-sm text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> {detectError}
              </span>
            )}
          </div>
        </div>


      </div>
    </div>
  );
}
