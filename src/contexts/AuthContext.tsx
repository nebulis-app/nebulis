import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCurrentUser, type UserRole } from '../lib/api/auth';
import { getAuthToken } from '../lib/api/client';

interface AuthContextValue {
  role: UserRole | null;
  isAdmin: boolean;
  isViewer: boolean;
  isLoaded: boolean;
  hasToken: boolean;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  role: null,
  isAdmin: false,
  isViewer: false,
  isLoaded: false,
  hasToken: false,
  refresh: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Tracks whether a JWT is stored. Updated synchronously in refresh() so the
  // login modal hides immediately after a successful login — no waiting for
  // the getCurrentUser fetch to resolve.
  const [tokenExists, setTokenExists] = useState(() => !!getAuthToken());

  const { data: currentUser, isSuccess, isError } = useQuery({
    queryKey: ['current-user'],
    queryFn: getCurrentUser,
    enabled: tokenExists,
    staleTime: 5 * 60_000,
    // This one query decides whether destructive controls render, so a
    // transient miss has outsized consequences. Retry harder than the global
    // default (1), re-check when the browser regains connectivity, and
    // background-revalidate every 5 minutes so a session that went degraded
    // (server bounce with the tab open, proxy hiccup) self-heals without a
    // manual reload.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    refetchOnReconnect: true,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });

  // When getCurrentUser returns a 401, fetchJSON clears the token from
  // localStorage but React state doesn't know. Sync here so the login
  // modal appears instead of silently failing on every subsequent write.
  useEffect(() => {
    if (isError && !getAuthToken()) {
      setTokenExists(false);
    }
  }, [isError]);

  useEffect(() => {
    const handler = () => setTokenExists(false);
    window.addEventListener('nebulis:auth-cleared', handler);
    return () => window.removeEventListener('nebulis:auth-cleared', handler);
  }, []);

  // A write just came back 403. Our cached role is stale or optimistic (the
  // user was demoted, or an earlier /auth/me failure left the role unknown).
  // Re-fetch so the UI stops offering actions the server rejects.
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['current-user'] });
    };
    window.addEventListener('nebulis:forbidden', handler);
    return () => window.removeEventListener('nebulis:forbidden', handler);
  }, [queryClient]);

  // No token → open-access mode (fresh install, no users): the server grants
  // admin to GETs and rejects writes with SETUP_REQUIRED, so admin is the
  // right role for the onboarding UI.
  // Token present, fetch pending → null (isLoaded=false; isAdmin stays false).
  // Token present, fetch errored → null. We do NOT fall back to admin: that
  // silently escalated viewers whenever /auth/me had a transient failure (or
  // during the plain startup race, before the first fetch resolves), showing
  // them destructive controls the server then rejects with 403. A failed
  // /auth/me means the server is unreachable or a proxy is 5xx'ing (the route
  // itself only ever answers 200 or 401); least privilege is the safe guess,
  // and the query self-heals on reconnect / window focus / the 5-min refetch.
  const role: UserRole | null = !tokenExists
    ? 'admin'
    : isSuccess
      ? currentUser.role
      : null;

  const isLoaded = !tokenExists || isSuccess || isError;

  const refresh = useCallback(() => {
    const hasToken = !!getAuthToken();
    setTokenExists(hasToken);
    queryClient.invalidateQueries({ queryKey: ['current-user'] });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => ({
    role,
    // Only ever true once the role is known and is 'admin'. Never true while
    // /auth/me is pending or errored, so a slow or failed permission check
    // can't flash destructive controls to a viewer.
    isAdmin: role === 'admin',
    isViewer: role === 'viewer',
    isLoaded,
    hasToken: tokenExists,
    refresh,
  }), [role, isLoaded, tokenExists, refresh]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
