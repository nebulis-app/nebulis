import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-8">
          <div className="max-w-md text-center space-y-4">
            <p className="text-4xl">⚠</p>
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-slate-400">
              An unexpected error occurred. Refresh the page to continue.
            </p>
            <pre className="text-xs text-left bg-slate-900 rounded-lg p-4 overflow-auto max-h-40 text-rose-400">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-accent-500 text-white rounded-lg text-sm font-medium hover:bg-accent-600 transition"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
