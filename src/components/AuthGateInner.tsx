/**
 * Inner auth gate — reads AuthContext and decides what to render.
 * Separated from AuthGate so it can useAuth() inside the provider.
 */

import { type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { SignIn } from './SignIn';

export function AuthGateInner({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();

  // Still checking existing session
  if (loading || session === undefined) {
    return (
      <div className="signin-container">
        <div className="signin-card">
          <p style={{ color: 'var(--muted)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Not signed in
  if (session === null) {
    return <SignIn />;
  }

  // Signed in — render the app
  return <>{children}</>;
}
