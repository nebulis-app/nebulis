/**
 * Integration goals and archived processing projects, in one card.
 *
 * These were two cards side by side, and on an object with neither they were
 * two empty-looking boxes between the banner and the pictures, each shouting
 * "None yet" at the same weight as the content below. As one card they read as
 * a single "project" strip: empty, it is one slim row; with data, the two
 * halves share a surface and a height instead of fighting over it.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { PanelOpenContext, type PanelOpenState } from './usePanelHalfOpen';
import { useTheme } from '../../hooks/useTheme';

export function ObjectProjectPanel({ children, stacked = false, sharedOpen = true }: {
  children: ReactNode;
  /** One column of halves, divided horizontally, for a narrow slot. Default is
   *  side by side from `md` up. */
  stacked?: boolean;
  /** The halves open and close together. Off when the card holds one section, which keeps its own state. */
  sharedOpen?: boolean;
}) {
  const { isDark } = useTheme();
  const [manual, setManual] = useState<boolean | null>(null);
  const [withContent, setWithContent] = useState<Record<string, boolean>>({});
  const report = useCallback(
    (key: string, has: boolean) => setWithContent(prev => (prev[key] === has ? prev : { ...prev, [key]: has })),
    [],
  );
  const state: PanelOpenState = {
    manual,
    setManual,
    anyContent: Object.values(withContent).some(Boolean),
    report,
  };
  const divider = isDark ? 'divide-slate-800' : 'divide-slate-200';
  return (
    <section
      className={`overflow-hidden rounded-2xl border ${
        isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white shadow-sm'
      }`}
    >
      <div
        className={`grid divide-y ${divider} ${stacked ? '' : `md:grid-cols-2 md:divide-x md:divide-y-0`}`}
      >
        {sharedOpen ? <PanelOpenContext.Provider value={state}>{children}</PanelOpenContext.Provider> : children}
      </div>
    </section>
  );
}
