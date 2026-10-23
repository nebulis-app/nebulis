import { useCallback, useState } from 'react';

/** Space the annotation dock keeps free beside the picture, in px (see `LightboxPane`'s `reserve`). */
export interface DockReserve { left: number; top: number }
export const NO_RESERVE: DockReserve = { left: 0, top: 0 };

/** The reserve a viewer passes to `LightboxPane`, and the stable callback the dock reports into. */
export function useDockReserve() {
  const [reserve, setReserve] = useState<DockReserve>(NO_RESERVE);
  const onReserve = useCallback((r: DockReserve) => {
    setReserve(prev => (prev.left === r.left && prev.top === r.top ? prev : r));
  }, []);
  return { reserve, onReserve };
}
