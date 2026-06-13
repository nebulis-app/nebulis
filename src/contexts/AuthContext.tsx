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

  // No token → open-access mode, treat as admin.
  // Token present but fetch pending → null (isLoaded=false guards rendering).
  // Token present and fetch errored → admin fallback to avoid locking out.
  const role: UserRole | null = !tokenExists
    ? 'admin'
    : isSuccess
      ? currentUser.role
      : isError
        ? (getAuthToken() ? 'admin' : null)
        : null;

  const isLoaded = !tokenExists || isSuccess || isError;

  const refresh = useCallback(() => {
    const hasToken = !!getAuthToken();
    setTokenExists(hasToken);
    queryClient.invalidateQueries({ queryKey: ['current-user'] });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => ({
    role,
    isAdmin: role === 'admin' || role === null,
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
