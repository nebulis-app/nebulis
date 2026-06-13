import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { loginUser } from '../lib/api/auth';
import { setAuthToken } from '../lib/api/client';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

export function LoginModal({ onLogin }: { onLogin: () => void }) {
  const { isDark } = useTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const loginMutation = useMutation({
    mutationFn: () => loginUser({ username, password }),
    onSuccess: (data) => {
      if (data?.token) setAuthToken(data.token);
      onLogin();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Login failed');
    },
  });

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const inputClass = `w-full px-4 py-3 rounded-xl border text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark
      ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600 focus:border-accent-500/50'
      : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-accent-400'
  }`;
  const labelClass = `block text-sm font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    loginMutation.mutate();
  }

  // Login is a non-dismissible auth gate. Esc should not close it (there is
  // nothing to return to), so onClose is a no-op.
  return (
    <Modal
      isOpen
      onClose={() => {}}
      title="Sign in to Nebulis"
      className={`w-full max-w-sm rounded-2xl border shadow-2xl p-8 ${card}`}
    >
      <div className="flex flex-col items-center mb-8">
        <div className="mb-4">
          <img src="/nebulis-64.png" alt="Nebulis" className="w-14 h-14" />
        </div>
        <h1 className={`text-xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          Nebu<span className="text-accent-500">lis</span>
        </h1>
        <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Sign in to continue
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className={inputClass}
            placeholder="e.g. astro_fan"
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className={inputClass}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </div>

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        <button
          type="submit"
          disabled={loginMutation.isPending || !username || !password}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent-500 hover:bg-accent-600 text-white font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <LogIn className="w-4 h-4" />
          {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Modal>
  );
}
