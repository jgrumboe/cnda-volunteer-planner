/**
 * AuthProvider — wraps the app in REMOTE mode, managing Supabase auth state.
 *
 * - Listens to onAuthStateChange to track sign-in/sign-out
 * - Consumes the auth callback URL fragment (detectSessionInUrl)
 * - Clears the fragment with history.replaceState after consumption
 * - Exposes session, signIn methods, and signOut via AuthContext
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AuthContext, type AuthState, type SessionInfo } from '../lib/auth';
import { getSupabaseClient } from '../lib/backend/supabase/client';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();

    // Check existing session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (s?.user?.email) {
        setSession({ email: s.user.email, role: 'organizer', personId: null });
      } else {
        setSession(null);
      }
      setLoading(false);
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (s?.user?.email) {
        setSession({ email: s.user.email, role: 'organizer', personId: null });
      } else {
        setSession(null);
      }
      setLoading(false);

      // Clear the auth callback fragment from the URL
      if (window.location.hash.includes('access_token') || window.location.hash.includes('error')) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    const supabase = getSupabaseClient();
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        queryParams: { hd: 'cloud-native.at' },
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (e) setError(e.message);
  }, []);

  const signInWithEmail = useCallback(async (email: string) => {
    setError(null);
    const supabase = getSupabaseClient();
    const { error: e } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (e) {
      setError(e.message);
      return { error: e.message };
    }
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut();
    setSession(null);
    setError(null);
  }, []);

  const value: AuthState = {
    session,
    signInWithGoogle,
    signInWithEmail,
    signOut,
    loading,
    error,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
