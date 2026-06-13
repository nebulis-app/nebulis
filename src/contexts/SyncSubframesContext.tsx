import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SyncSubframesModal } from '../components/SyncSubframesModal';

interface SyncArgs { objectId: string; sessionId: string; }

interface SyncSubframesContextValue {
  openSync: (objectId: string, sessionId: string) => void;
}

const SyncSubframesContext = createContext<SyncSubframesContextValue | null>(null);

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

  const handleComplete = useCallback(() => {
    const current = argsRef.current;
    if (!current) return;
    queryClient.invalidateQueries({ queryKey: ['observation', current.objectId, current.sessionId] });
    queryClient.invalidateQueries({ queryKey: ['observation-files', current.objectId, current.sessionId] });
    queryClient.invalidateQueries({ queryKey: ['library-sessions', current.objectId] });
  }, [queryClient]);

  const contextValue = useMemo<SyncSubframesContextValue>(() => ({ openSync }), [openSync]);

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

export function useSyncSubframes(): SyncSubframesContextValue {
  const ctx = useContext(SyncSubframesContext);
  if (!ctx) throw new Error('useSyncSubframes must be used within SyncSubframesProvider');
  return ctx;
}
