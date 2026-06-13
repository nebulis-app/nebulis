import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Tv, Check, ArrowRight, Loader2 } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import { lookupPairingCode, approvePairingCode } from '../lib/api/devices';

const ALPHABET = /^[A-Z2-9]*$/;
const CODE_LEN = 4;

function normalize(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
}

function display(raw: string): string {
  return raw;
}

export default function LinkDevicePage() {
  const { isDark } = useTheme();
  const { isLoaded, role } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState('');
  const [tvName, setTvName] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ tvName: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auto-focus the code input on mount.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const lookup = useMutation({
    mutationFn: lookupPairingCode,
    onSuccess: data => { setTvName(data.tvName); setErrorMessage(null); },
    onError: (e: Error) => { setTvName(null); setErrorMessage(e.message); },
  });

  const approve = useMutation({
    mutationFn: approvePairingCode,
    onSuccess: data => { setLinked({ tvName: data.tvName }); setErrorMessage(null); },
    onError: (e: Error) => setErrorMessage(e.message),
  });

  // Live lookup: as soon as 8 valid chars are entered, fetch the TV name so
  // the user sees what they're about to link before they confirm.
  const { mutate: doLookup } = lookup;
  useEffect(() => {
    if (raw.length !== CODE_LEN) {
      setTvName(null);
      setErrorMessage(null);
      return;
    }
    doLookup(raw);
  }, [raw, doLookup]);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = normalize(e.target.value);
    if (!ALPHABET.test(next)) return;
    setRaw(next);
  }

  function onConfirm() {
    if (raw.length !== CODE_LEN || !tvName) return;
    approve.mutate(raw);
  }

  // Loading auth state — render nothing to avoid flash.
  if (!isLoaded) return null;

  // Not signed in — give a clean, premium "sign in first" rather than redirect
  // chain. The user landed here from their TV, so context matters.
  if (!role) {
    return (
      <div className="max-w-lg mx-auto pt-16 text-center">
        <p className={isDark ? 'text-slate-300' : 'text-slate-600'}>
          Sign in to your Nebulis account, then return here to link your TV.
        </p>
      </div>
    );
  }

  // Success state.
  if (linked) {
    return (
      <div className="max-w-lg mx-auto pt-20 px-6 text-center">
        <div className={`w-20 h-20 rounded-full mx-auto flex items-center justify-center ${isDark ? 'bg-emerald-500/15' : 'bg-emerald-50'}`}>
          <Check className={`w-10 h-10 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
        </div>
        <h1 className={`mt-6 font-display font-bold text-3xl tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {linked.tvName} linked
        </h1>
        <p className={`mt-3 text-sm leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          Look at your TV. It should sign in within a few seconds. You can
          disconnect this device anytime from <span className="font-medium">Settings → Devices</span>.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold bg-accent-500 text-white hover:bg-accent-600 active:scale-[0.99] transition-all"
        >
          Back to library <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  const codeReady = raw.length === CODE_LEN;
  const ringColor = errorMessage
    ? 'border-rose-500/60 ring-2 ring-rose-500/20'
    : tvName
      ? 'border-emerald-500/60 ring-2 ring-emerald-500/20'
      : isDark
        ? 'border-slate-700 focus-within:border-accent-500/60 focus-within:ring-2 focus-within:ring-accent-500/20'
        : 'border-slate-200 focus-within:border-accent-500/60 focus-within:ring-2 focus-within:ring-accent-500/20';

  return (
    <div className="max-w-xl mx-auto pt-12 px-6">
      <div className="text-center">
        <div className={`w-16 h-16 rounded-2xl mx-auto flex items-center justify-center ${isDark ? 'bg-accent-500/10' : 'bg-accent-100'}`}>
          <Tv className={`w-8 h-8 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
        </div>
        <h1 className={`mt-6 font-display font-bold text-3xl tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Link an Apple TV
        </h1>
        <p className={`mt-3 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          Enter the code shown on your TV.
        </p>
      </div>

      <div className={`mt-10 rounded-2xl border px-6 py-8 transition-all ${ringColor} ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          value={display(raw)}
          onChange={onChange}
          placeholder="XXXX"
          aria-label="Pairing code"
          className={`w-full bg-transparent text-center font-mono tracking-[0.4em] text-3xl sm:text-4xl font-bold uppercase outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 rounded-lg ${
            isDark ? 'text-white placeholder-slate-700' : 'text-slate-900 placeholder-slate-300'
          }`}
        />
      </div>

      {/* Status line — animates between idle / lookup / found / error */}
      <div className="mt-5 min-h-[3rem] flex items-center justify-center">
        {codeReady && lookup.isPending && (
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
    </div>
  );
}
