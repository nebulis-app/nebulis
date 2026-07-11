import { WifiOff } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

/**
 * Shown when the initial /auth/status check fails and there is no stored
 * token to fall back on. Without this gate, App.tsx's showLogin/showOnboarding
 * both stay false (authStatus is undefined), so the full SPA rendered behind
 * a server that isn't answering yet, with every request failing silently and
 * no way to sign in.
 */
export function ConnectionErrorScreen({ onRetry }: { onRetry: () => void }) {
  const { isDark } = useTheme();
  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';

  return (
    <Modal
      isOpen
      onClose={() => {}}
      title="Can't reach the Nebulis server"
      className={`w-full max-w-sm rounded-2xl border shadow-2xl p-8 text-center ${card}`}
    >
      <div className="flex flex-col items-center">
        <div className={`mb-4 p-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
          <WifiOff className={`w-6 h-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
        </div>
        <h1 className={`text-xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          Can't reach the server
        </h1>
        <p className={`text-sm mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Nebulis is still starting up, or the connection was interrupted. Try again in a moment.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 w-full px-4 py-3 rounded-xl bg-accent-500 hover:bg-accent-600 text-white font-medium text-sm transition-colors"
        >
          Retry
        </button>
      </div>
    </Modal>
  );
}
