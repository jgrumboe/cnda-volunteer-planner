/**
 * Local backend — wraps localStorage with the same row-write path as REMOTE.
 *
 * This means the diff, debounce and rollback machinery runs on every dev session,
 * so its bugs surface without any Supabase setup.
 *
 * HARD RULE: Must not import @supabase/supabase-js or reference import.meta.
 */

import type { PlanState } from '../../types';
import type { PlanBackend, RowOp, SyncError, ConnectionState } from './types';
import { loadState, saveState } from '../storage';
import { createSeedState } from '../seed';

export function createLocalBackend(): PlanBackend {
  let currentState: PlanState | null = null;

  const backend: PlanBackend = {
    get connection(): ConnectionState {
      return 'local';
    },

    async load(): Promise<PlanState> {
      currentState = loadState() ?? createSeedState();
      return currentState;
    },

    async push(_ops: RowOp[]): Promise<SyncError[]> {
      // In LOCAL mode, the actual persistence is done via the saveState call
      // triggered by the usePlan hook's effect. The push is a no-op here
      // because we save the full state (not individual rows) to localStorage.
      // This path exists so the diff/debounce machinery still runs.
      return [];
    },

    async replacePlan(state: PlanState): Promise<SyncError | null> {
      currentState = state;
      saveState(state);
      return null;
    },

    subscribe(_callback: (state: PlanState) => void): () => void {
      // LOCAL mode has no remote events.
      return () => {};
    },

    flush(): void {
      // Persistence happens synchronously via saveState in the effect.
    },

    destroy(): void {
      // Nothing to tear down.
    },
  };

  return backend;
}
