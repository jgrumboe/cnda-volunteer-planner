/**
 * Authentication context and hooks.
 *
 * In LOCAL mode, no auth is needed — the session is always null and canEdit is true.
 * In REMOTE mode, this provides Google OAuth and magic link sign-in via Supabase Auth.
 */

import { createContext, useContext } from 'react';

/**
 * Only the email is known at the auth layer. Role and personId are
 * plan-specific membership facts, not auth facts — they come from the
 * get_plan RPC (see usePlan) and must never be assumed here. A prior
 * version hardcoded role: 'organizer' for every signed-in user; nothing
 * read it, but it was a footgun waiting for a future consumer.
 */
export interface SessionInfo {
  email: string;
}

export interface AuthState {
  /** null = not signed in, undefined = still loading */
  session: SessionInfo | null | undefined;
  /** Sign in with Google (Workspace preselected via hd param). */
  signInWithGoogle: () => Promise<void>;
  /** Sign in with magic link email. */
  signInWithEmail: (email: string) => Promise<{ error: string | null }>;
  /** Sign out and clear session. */
  signOut: () => Promise<void>;
  /** Whether auth is actively loading (initial session check). */
  loading: boolean;
  /** Error from the last auth operation. */
  error: string | null;
}

const defaultAuth: AuthState = {
  session: null,
  signInWithGoogle: async () => {},
  signInWithEmail: async () => ({ error: null }),
  signOut: async () => {},
  loading: false,
  error: null,
};

export const AuthContext = createContext<AuthState>(defaultAuth);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
