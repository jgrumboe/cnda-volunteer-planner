/**
 * Backend selector — the ONLY module touching import.meta.env.
 *
 * No env vars → LOCAL mode → `npm run dev` works with zero setup, exactly as today.
 */

import type { PlanBackend } from './types';
import { createLocalBackend } from './local';

export type BackendMode = 'local' | 'remote';

export function getBackendMode(): BackendMode {
  // In a Vite build, import.meta.env is available.
  // If VITE_SUPABASE_URL is set, we're in REMOTE mode.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
    if (url && url.length > 0) return 'remote';
  } catch {
    // Not in a Vite context (e.g. selftest running on Node) — always local.
  }
  return 'local';
}

export function getBackend(): PlanBackend {
  const mode = getBackendMode();
  if (mode === 'remote') {
    // TODO Phase 2 step 5: return createSupabaseBackend()
    // For now, fall back to local.
    return createLocalBackend();
  }
  return createLocalBackend();
}

export { type PlanBackend, type ConnectionState, type SyncError, type RowOp } from './types';
