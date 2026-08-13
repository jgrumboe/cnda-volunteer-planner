/**
 * Sign-in card: Google OAuth + magic link email.
 *
 * This component renders when the user is not authenticated in REMOTE mode.
 * It provides two paths per the plan:
 * - "Continue with Google" (hd: 'cloud-native.at' preselection)
 * - Email magic link field
 */

import { useState } from 'react';
import { useAuth } from '../lib/auth';

export function SignIn() {
  const { signInWithGoogle, signInWithEmail, loading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setEmailError(null);
    const result = await signInWithEmail(email.trim());
    if (result.error) {
      setEmailError(result.error);
    } else {
      setEmailSent(true);
    }
  };

  return (
    <div className="signin-container">
      <div className="signin-card">
        <h1>Volunteer Planner</h1>
        <p className="signin-subtitle">Cloud Native Days Austria 2026</p>

        {error ? <div className="signin-error">{error}</div> : null}

        <button
          className="btn primary signin-google"
          onClick={signInWithGoogle}
          disabled={loading}
        >
          Continue with Google
        </button>

        <div className="signin-divider">
          <span>or</span>
        </div>

        {emailSent ? (
          <div className="signin-success">
            Check your email for a sign-in link. You can close this tab.
          </div>
        ) : (
          <form onSubmit={handleEmail} className="signin-form">
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              autoComplete="email"
            />
            <button className="btn" type="submit" disabled={loading || !email.trim()}>
              Send magic link
            </button>
            {emailError ? <div className="signin-error">{emailError}</div> : null}
          </form>
        )}

        <p className="signin-hint">
          You need an invitation to access the plan. If you don't have one, ask an organizer.
        </p>
      </div>
    </div>
  );
}

/**
 * Not-invited screen: shown when the user is authenticated but has no membership.
 * Displays the email that was seen so mismatches are self-diagnosing.
 */
export function NotInvited({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <div className="signin-container">
      <div className="signin-card">
        <h1>Not invited</h1>
        <p className="signin-subtitle">
          This plan is invite-only. The account <strong>{email}</strong> does not have access.
        </p>
        <p className="signin-hint">
          If you expected access, check that you're using the right account — your work
          email might differ from your personal one.
        </p>
        <button className="btn" onClick={onSignOut}>
          Sign out and try a different account
        </button>
      </div>
    </div>
  );
}
