import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { getBackendMode } from './lib/backend/index';
import { AuthGate } from './components/AuthGate';

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
