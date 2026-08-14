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
        setSession({ email: s.user.email });
      } else {
        setSession(null);
      }
      setLoading(false);
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (s?.user?.email) {
        setSession({ email: s.user.email });
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
        // `hd` only preselects/hints the Workspace domain on Google's consent
        // screen — it does not restrict which accounts can complete sign-in
        // (any Google account can still authenticate). The real authorization
        // boundary is the memberships table: get_plan returns `not_a_member`
        // for anyone without a row there, regardless of email domain. A hard
        // domain restriction at sign-in would need a Supabase Auth Hook
        // configured on the project itself (outside this repo).
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
