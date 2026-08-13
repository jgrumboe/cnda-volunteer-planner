/**
 * AuthGate — orchestrates the auth flow in REMOTE mode.
 *
 * - Shows a loading spinner while checking session
 * - Shows SignIn when not authenticated
 * - Renders children (App) when authenticated
 *
 * The "not a member" case is handled inside usePlan when get_plan returns
 * the not_a_member error — it surfaces as a dedicated screen.
 */

import { type ReactNode } from 'react';
import { AuthProvider } from './AuthProvider';
import { AuthGateInner } from './AuthGateInner';

export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthGateInner>{children}</AuthGateInner>
    </AuthProvider>
  );
}
