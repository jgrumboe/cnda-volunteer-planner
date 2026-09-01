import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { getBackendMode } from './lib/backend/index';
import { AuthGate } from './components/AuthGate';

// Clickjacking stopgap. The real defence is `frame-ancestors 'none'`, but that
// directive is ignored on a meta-tag CSP and GitHub Pages cannot send response
// headers, so there is nothing else holding this line today. Remove once the
// site sits behind something that can set the header (see README).
//
// An attacker can defeat this by sandboxing the iframe without `allow-scripts`
// — but then React never boots and there is no UI to trick anyone into
// clicking, which is the outcome we want anyway. Runs before render so no
// organizer-only control is ever painted inside a frame.
if (window.self !== window.top) {
  document.documentElement.textContent =
    'This app cannot be embedded in another page. Open it directly instead.';
  throw new Error('Refusing to run inside a frame.');
}

const mode = getBackendMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {mode === 'remote' ? (
      <AuthGate>
        <App />
      </AuthGate>
    ) : (
      <App />
    )}
  </StrictMode>,
);
