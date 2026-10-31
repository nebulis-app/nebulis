import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  /** The boundary clears itself when this changes, so leaving the broken page is enough to recover. */
  resetKey: string;
}

interface State {
  error: Error | null;
}

class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RouteErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const isLight = document.documentElement.classList.contains('light');
    const t = (key: string) => i18n.t(`routeError.${key}`, { ns: 'common' });
    return (
      <div role="alert" className="flex items-center justify-center p-8 min-h-[50vh]">
        <div className="max-w-md text-center space-y-4">
          <h1 className={`text-xl font-semibold ${isLight ? 'text-slate-800' : 'text-slate-100'}`}>{t('title')}</h1>
          <p className={`text-sm ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{t('description')}</p>
          <pre className={`text-xs text-left rounded-lg p-4 overflow-auto max-h-40 text-rose-500 ${
            isLight ? 'bg-white border border-slate-200' : 'bg-slate-900'
          }`}>
            {this.state.error.message}
          </pre>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-accent-500 text-white rounded-lg text-sm font-medium hover:bg-accent-600 transition"
            >
              {t('tryAgain')}
            </button>
            <Link
              to="/"
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                isLight ? 'text-slate-800 border border-slate-300 hover:bg-slate-100' : 'text-slate-100 border border-slate-700 hover:bg-slate-800'
              }`}
            >
              {t('backToLibrary')}
            </Link>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Catches a render crash inside one page so the navigation stays on screen. The app-level ErrorBoundary replaces the
 * whole window and its only exit is a reload, which reproduces a deterministic crash.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  return <Boundary resetKey={pathname + search}>{children}</Boundary>;
}
