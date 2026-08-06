import { createContext, useContext } from 'react';

export interface SyncSubframesContextValue {
  openSync: (objectId: string, sessionId: string) => void;
}

/**
 * The context object lives in its own module, apart from the provider, so a
 * Fast Refresh update never recreates it.
 *
 * SyncSubframesContext.tsx exports both a component and this hook, which makes
 * it an invalid Fast Refresh boundary: an edit anywhere downstream (the sync
 * modal, most often) re-executes it. When createContext() lived there, that
 * produced a brand new context object while the mounted provider still held
 * the old one, so every consumer read null and this hook threw
 * "must be used within SyncSubframesProvider" until a hard reload.
 *
 * This module imports nothing from the provider or the modal, so it is never
 * downstream of those edits and the object identity is stable.
 */
export const SyncSubframesContext = createContext<SyncSubframesContextValue | null>(null);

export function useSyncSubframes(): SyncSubframesContextValue {
  const ctx = useContext(SyncSubframesContext);
  if (!ctx) throw new Error('useSyncSubframes must be used within SyncSubframesProvider');
  return ctx;
}
