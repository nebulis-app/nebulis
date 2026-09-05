import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Check, ArrowRight, Loader2 } from 'lucide-react';
import { lookupPairingCode, approvePairingCode } from '../../lib/api/devices';
import { Modal } from '../ui/Modal';

const ALPHABET = /^[A-Z2-9]*$/;
const CODE_LEN = 4;

function normalize(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
}

/**
 * "Enter code" dialog for linking an Apple TV.
 *
 * The TV shows a short code; the signed-in web user types it here. We live-lookup
 * the TV name as soon as a full code is entered so the user sees what they are
 * about to link before confirming, then approve and close on success.
 */
export function EnterCodeModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState('');
  const [linked, setLinked] = useState<{ tvName: string } | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Auto-focus the code input on open. Modal's own focus effect targets the
  // first focusable child (the close button); this runs after it and lands on
  // the input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live lookup, keyed by the code itself rather than a plain useMutation: as
  // soon as a full code is entered, fetch the TV name so the user sees what
  // they're about to link before they confirm. A mutation has no last-write-
  // wins semantics — retype a code fast enough (type, backspace, retype a
  // different one) and two lookups race, and whichever resolves last wins
  // even if it isn't for the code currently in the box. Keying by `raw` gives
  // each code its own cache entry, so `data`/`error` always describe the code
  // that's actually in the input right now, and backing away from a complete
  // code naturally shows nothing (a disabled query for the shorter code was
  // never fetched) instead of needing a manual clear.
  const lookup = useQuery({
    queryKey: ['pairing-lookup', raw],
    queryFn: () => lookupPairingCode(raw),
    enabled: raw.length === CODE_LEN,
    retry: false,
  });
  const tvName = lookup.data?.tvName ?? null;
  const lookupError = lookup.error instanceof Error ? lookup.error.message : null;
  const errorMessage = approveError ?? lookupError;

  const approve = useMutation({
    mutationFn: approvePairingCode,
    onSuccess: data => { setLinked({ tvName: data.tvName }); setApproveError(null); },
    onError: (e: Error) => setApproveError(e.message),
  });

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = normalize(e.target.value);
    if (!ALPHABET.test(next)) return;
    setRaw(next);
    setApproveError(null);
  }

  function onConfirm() {
    if (raw.length !== CODE_LEN || !tvName) return;
    approve.mutate(raw);
  }

  // On a successful link, refresh the device list and auto-close.
  useEffect(() => {
    if (!linked) return;
    queryClient.invalidateQueries({ queryKey: ['connected-devices'] });
    const id = setTimeout(onClose, 2200);
    return () => clearTimeout(id);
  }, [linked, queryClient, onClose]);

  const codeReady = raw.length === CODE_LEN;
  const headerBorder = 'border-slate-200/60 dark:border-slate-800/60';

  // No idle border: the modal already draws a card border, so a second border
  // around the input reads as a double outline. Feedback states still get a
  // colored border + ring.
  const ringColor = errorMessage
    ? 'border-rose-500/60 ring-2 ring-rose-500/20'
    : tvName
      ? 'border-emerald-500/60 ring-2 ring-emerald-500/20'
      : 'border-transparent focus-within:border-accent-500/60 focus-within:ring-2 focus-within:ring-accent-500/20';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Link an Apple TV"
      className={`w-full max-w-md rounded-2xl border shadow-xl ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}
    >
      <div className={`flex items-center justify-between px-5 py-4 border-b ${headerBorder}`}>
        <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
          Link an Apple TV
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
        {linked ? (
          <div className="flex flex-col items-center text-center py-6">
            <Check className="w-14 h-14 text-emerald-500 mb-3" />
            <p className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {linked.tvName} linked
            </p>
            <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Look at your TV. It should sign in within a few seconds.
            </p>
          </div>
        ) : (
          <>
            <p className={`text-sm text-center mb-5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Enter the code shown on your TV.
            </p>

            <div className={`rounded-2xl border px-6 py-6 transition-all ${ringColor} ${isDark ? 'bg-slate-950/40' : 'bg-slate-50/60'}`}>
              <input
                ref={inputRef}
                autoFocus
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={raw}
                onChange={onChange}
                placeholder="XXXX"
                aria-label="Pairing code"
                className={`w-full bg-transparent text-center font-mono tracking-[0.4em] text-3xl font-bold uppercase outline-none ${
                  isDark ? 'text-white placeholder-slate-700' : 'text-slate-900 placeholder-slate-300'
                }`}
              />
            </div>

            {/* Status line — animates between idle / lookup / found / error */}
            <div className="mt-4 min-h-[2.5rem] flex items-center justify-center">
              {codeReady && lookup.isFetching && (
                <p className={`flex items-center gap-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Looking up code…
                </p>
              )}
              {codeReady && tvName && !errorMessage && (
                <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  Link <span className="font-semibold">{tvName}</span> to your account?
                </p>
              )}
              {codeReady && errorMessage && (
                <p className="text-sm text-rose-500">{errorMessage}</p>
              )}
            </div>

            <button
              type="button"
              onClick={onConfirm}
              disabled={!tvName || approve.isPending}
              className={`mt-2 w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl text-sm font-semibold transition-all ${
                tvName
                  ? 'bg-accent-500 text-white hover:bg-accent-600 active:scale-[0.99]'
                  : isDark
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {approve.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <>Link <ArrowRight className="w-4 h-4" /></>
              }
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
