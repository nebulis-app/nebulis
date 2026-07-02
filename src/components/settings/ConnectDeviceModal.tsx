import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Smartphone, CheckCircle2, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { createDeviceQr, getDeviceQrStatus, type DeviceQrEnrollment } from '../../lib/api';

/**
 * "Connect a device" QR dialog.
 *
 * Generates a pre-approved, short-lived pairing and renders it as a QR. A phone
 * running Nebulis scans it to connect AND sign in to this server in one step,
 * with no IP typing. We poll the read-only status endpoint (never /pair/poll,
 * which would consume the code) and close once the phone has connected.
 */
export function ConnectDeviceModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<DeviceQrEnrollment | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const generate = useMutation({
    mutationFn: () => createDeviceQr(),
    onSuccess: setEnrollment,
  });

  // Generate the first code on open. Ref guard so React 19 StrictMode's double
  // effect doesn't mint two pairings.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    generate.mutate();
  }, [generate]);

  const expired = secondsLeft !== null && secondsLeft <= 0;

  // Poll for completion. Stops once connected or expired.
  const statusQuery = useQuery({
    queryKey: ['device-qr-status', enrollment?.deviceCode],
    queryFn: () => {
      if (!enrollment) throw new Error('enrollment is null');
      return getDeviceQrStatus(enrollment.deviceCode);
    },
    enabled: !!enrollment && !expired,
    refetchInterval: q =>
      q.state.data?.status === 'connected' ? false : (enrollment?.pollIntervalSec ?? 3) * 1000,
  });
  const connected = statusQuery.data?.status === 'connected';
  const connectedName = connected ? (statusQuery.data?.deviceName ?? 'Device') : null;

  // Countdown to expiry.
  useEffect(() => {
    if (!enrollment || connected) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((enrollment.expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [enrollment, connected]);

  // Side effects on a successful connect: refresh the device list and auto-close.
  useEffect(() => {
    if (!connected) return;
    queryClient.invalidateQueries({ queryKey: ['connected-devices'] });
    const id = setTimeout(onClose, 1800);
    return () => clearTimeout(id);
  }, [connected, queryClient, onClose]);

  const isLoading = generate.isPending && !enrollment;
  const headerBorder = 'border-slate-200/60 dark:border-slate-800/60';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect a device"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-md rounded-2xl border shadow-xl ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className={`flex items-center justify-between px-5 py-4 border-b ${headerBorder}`}>
          <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Connect a device
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-6">
          {connectedName ? (
            <div className="flex flex-col items-center text-center py-6">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mb-3" />
              <p className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {connectedName} connected
              </p>
              <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Your phone is signed in and ready.
              </p>
            </div>
          ) : (
            <>
              <p className={`text-sm text-center mb-5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Open Nebulis on your phone, tap{' '}
                <span className={`font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Scan QR</span>,
                and point it at this code. It connects and signs in, no IP address needed.
              </p>

              <div className="flex items-center justify-center">
                <div
                  className={`relative rounded-2xl p-3 ${
                    isDark ? 'bg-white' : 'bg-white border border-slate-200'
                  }`}
                  style={{ width: 248, height: 248 }}
                >
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="w-7 h-7 animate-spin text-slate-400" />
                    </div>
                  )}

                  {generate.isError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4 text-slate-600">
                      <AlertTriangle className="w-7 h-7 text-amber-500 mb-2" />
                      <p className="text-xs">
                        {generate.error?.message ?? 'Could not generate a code.'}
                      </p>
                    </div>
                  )}

                  {enrollment && !generate.isError && (
                    <>
                      <img
                        src={enrollment.qrDataUrl}
                        alt="Pairing QR code"
                        className="w-full h-full"
                        style={{ imageRendering: 'pixelated', opacity: expired ? 0.15 : 1 }}
                      />
                      {expired && (
                        <button
                          type="button"
                          onClick={() => generate.mutate()}
                          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-700"
                        >
                          <RefreshCw className="w-7 h-7" />
                          <span className="text-sm font-medium">Code expired. Tap to refresh.</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="mt-5 flex items-center justify-center gap-2 text-xs">
                {enrollment && !expired && (
                  <span className={`inline-flex items-center gap-1.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    <Smartphone className="w-3.5 h-3.5" />
                    Waiting for your phone
                    {secondsLeft !== null && (
                      <span className="tabular-nums">
                        · expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                      </span>
                    )}
                  </span>
                )}
              </div>

              {enrollment?.url && !expired && (
                <p className={`mt-3 text-center text-[11px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  Can&apos;t scan? Enter this address manually:{' '}
                  <span className={`font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{enrollment.url}</span>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
