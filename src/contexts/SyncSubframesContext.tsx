import { useState, useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SyncSubframesModal } from '../components/SyncSubframesModal';
import { SyncSubframesContext, type SyncSubframesContextValue } from './syncSubframesContextObject';

interface SyncArgs { objectId: string; sessionId: string | null; }

export function SyncSubframesProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [args, setArgs] = useState<SyncArgs | null>(null);
  // Keep a ref in sync so handleComplete (a stable useCallback) always sees
  // current args without re-creating on every args change.
  const argsRef = useRef<SyncArgs | null>(null);

  const openSync = useCallback((objectId: string, sessionId: string) => {
    const next = { objectId, sessionId };
    argsRef.current = next;
    setArgs(next);
  }, []);

  const openObjectSync = useCallback((objectId: string) => {
    const next = { objectId, sessionId: null };
    argsRef.current = next;
    setArgs(next);
  }, []);

  const handleComplete = useCallback(() => {
    const current = argsRef.current;
    if (!current) return;
    if (current.sessionId) {
      queryClient.invalidateQueries({ queryKey: ['observation', current.objectId, current.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['observation-files', current.objectId, current.sessionId] });
    } else {
      // Object-wide sync touched every night — drop the whole family's caches.
      queryClient.invalidateQueries({ queryKey: ['observation', current.objectId] });
      queryClient.invalidateQueries({ queryKey: ['observation-files', current.objectId] });
    }
    queryClient.invalidateQueries({ queryKey: ['library-sessions', current.objectId] });
  }, [queryClient]);

  const contextValue = useMemo<SyncSubframesContextValue>(
    () => ({ openSync, openObjectSync }),
    [openSync, openObjectSync],
  );

  return (
    <SyncSubframesContext.Provider value={contextValue}>
      {children}
      {args && (
        <SyncSubframesModal
          objectId={args.objectId}
          sessionId={args.sessionId}
          onComplete={handleComplete}
          onClose={() => setArgs(null)}
        />
      )}
    </SyncSubframesContext.Provider>
  );
}

// Re-exported so existing imports keep working. The binding points at the
// stable module above, so the hook and the context object it reads stay in
// sync across Fast Refresh updates.
export { useSyncSubframes } from './syncSubframesContextObject';
