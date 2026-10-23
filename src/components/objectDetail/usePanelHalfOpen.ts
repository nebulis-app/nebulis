import { createContext, useContext, useEffect } from 'react';

export interface PanelOpenState {
  manual: boolean | null;
  setManual: (open: boolean) => void;
  anyContent: boolean;
  report: (key: string, hasContent: boolean) => void;
}
export const PanelOpenContext = createContext<PanelOpenState | null>(null);

/** Open state for one half of the panel. Inside the panel the halves open and
 *  close together, because the card is one surface: a collapsed half beside an
 *  expanded one stretches to the same height and reads as open but empty.
 *  Outside a panel it is the section's own state (`ownDefault` until toggled). */
export function usePanelHalfOpen(key: string, hasContent: boolean, own: [boolean | null, (open: boolean | null) => void]) {
  const ctx = useContext(PanelOpenContext);
  const report = ctx?.report;
  useEffect(() => { report?.(key, hasContent); }, [report, key, hasContent]);
  if (!ctx) return { isOpen: own[0] ?? hasContent, setOpen: own[1] };
  return { isOpen: ctx.manual ?? ctx.anyContent, setOpen: ctx.setManual };
}
