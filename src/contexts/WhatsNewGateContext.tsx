import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Gates the guided product tour behind the auto "What's new" popup.
 *
 * Both are auto-launched on their own triggers (tour: right after onboarding
 * closes; What's New: a server-side version comparison), so on a fresh
 * install they used to fire at the same moment and stack on top of each
 * other. `settled` starts false and flips to true exactly once, either
 * because What's New determined there was nothing to show or because the
 * user dismissed it. `TourProvider.autoStart` waits on this before ever
 * calling `start()`.
 */
interface WhatsNewGateValue {
  settled: boolean;
  markSettled: () => void;
}

const WhatsNewGateContext = createContext<WhatsNewGateValue | null>(null);

export function WhatsNewGateProvider({ children }: { children: ReactNode }) {
  const [settled, setSettled] = useState(false);
  const settledRef = useRef(false);

  const markSettled = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setSettled(true);
  };

  const value = useMemo<WhatsNewGateValue>(() => ({ settled, markSettled }), [settled]);

  return <WhatsNewGateContext.Provider value={value}>{children}</WhatsNewGateContext.Provider>;
}

export function useWhatsNewGate(): WhatsNewGateValue {
  const ctx = useContext(WhatsNewGateContext);
  if (!ctx) throw new Error('useWhatsNewGate must be used within a WhatsNewGateProvider');
  return ctx;
}
