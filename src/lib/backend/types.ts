/**
 * Backend abstraction — the seam between the UI and persistence.
 *
 * HARD RULE: This file must not import @supabase/supabase-js or reference import.meta.
 */

import type { PlanState } from '../../types';

// ---------------------------------------------------------------- connection

export type ConnectionState =
  | 'local'       // No server, pure localStorage
  | 'connecting'  // Attempting initial load or reconnect
  | 'live'        // Connected and subscribed
  | 'readonly'    // Connected but edits disabled (offline/stale)
  | 'error';      // Unrecoverable failure

// ---------------------------------------------------------------- sync errors

export interface SyncError {
  code: string;           // Postgres error code or 'NETWORK'
  message: string;
  /** The row ID(s) that failed, for rollback targeting. */
  rowIds?: string[];
  retryable: boolean;
}

// ---------------------------------------------------------------- row operations

export type RowCollection = 'days' | 'people' | 'tasks' | 'assignments';

export interface RowOp {
  collection: RowCollection;
  type: 'upsert' | 'delete';
  id: string;             // For assignments: assignmentKey(taskId, personId)
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------- session

export interface Session {
  email: string;
  role: 'organizer' | 'volunteer';
  personId: string | null;
}

// ---------------------------------------------------------------- backend interface

export interface PlanBackend {
  /** Current connection state. */
  readonly connection: ConnectionState;

  /** Role and personId after successful load (null before load or in LOCAL mode). */
  readonly role: 'organizer' | 'volunteer' | null;
  readonly personId: string | null;

  /**
   * Load the plan. Returns the initial state.
   * For LOCAL mode this reads localStorage; for REMOTE it calls get_plan.
   */
  load(): Promise<PlanState>;

  /**
   * Push row-level changes to the backend.
   * LOCAL mode writes to localStorage; REMOTE mode sends to PostgREST.
   * Returns the ops that failed (empty = all succeeded).
   */
  push(ops: RowOp[]): Promise<SyncError[]>;

  /**
   * Replace the entire plan atomically (import, reset).
   * LOCAL mode writes to localStorage; REMOTE calls replace_plan RPC.
   */
  replacePlan(state: PlanState): Promise<SyncError | null>;

  /**
   * Subscribe to inbound changes from other clients.
   * LOCAL mode never fires. REMOTE mode relays realtime events.
   * Returns an unsubscribe function.
   */
  subscribe(callback: (state: PlanState) => void): () => void;

  /** Flush any pending writes (pagehide, visibilitychange). */
  flush(): void;

  /** Tear down connections and timers. */
  destroy(): void;
}

// ---------------------------------------------------------------- row clocks

/**
 * Server timestamps per row, kept outside PlanState so exports stay clean.
 * Key is the row's id (or assignmentKey for assignments).
 */
export type RowClocks = Map<string, string>;

export interface AllClocks {
  days: RowClocks;
  people: RowClocks;
  tasks: RowClocks;
  assignments: RowClocks;
}
