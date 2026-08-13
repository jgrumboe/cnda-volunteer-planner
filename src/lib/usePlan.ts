/**
 * usePlan — the single hook that replaces raw useState + useEffect in App.tsx.
 *
 * In LOCAL mode this behaves identically to the original: state in memory, persisted
 * to localStorage on every change. The diff/debounce path runs on every write so its
 * bugs surface without any Supabase setup.
 *
 * In REMOTE mode (future) it will push row-level diffs and merge inbound events.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanState } from '../types';
import { getBackend } from './backend/index';
import type { PlanBackend, ConnectionState } from './backend/types';
import { diffAll } from './backend/diff';
import { createRowSync, type RowSync } from './backend/rowsync';
import { saveState } from './storage';

export interface UsePlanResult {
  state: PlanState;
  setState: React.Dispatch<React.SetStateAction<PlanState>>;
  /** Atomically replace the entire plan (for import/restore/reset). */
  replacePlan: (state: PlanState) => Promise<void>;
  connection: ConnectionState;
  /** True when the current user has write access (organizer or local mode). */
  canEdit: boolean;
  /** The user's role from the memberships table (null in LOCAL mode). */
  role: 'organizer' | 'volunteer' | null;
  /** The person_id linked to this user in the memberships table. */
  personId: string | null;
  error: string | null;
  setError: (err: string | null) => void;
}

export function usePlan(): UsePlanResult {
  const [state, setStateRaw] = useState<PlanState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [role, setRole] = useState<'organizer' | 'volunteer' | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backendRef = useRef<PlanBackend | null>(null);
  const rowSyncRef = useRef<RowSync | null>(null);
  const baselineRef = useRef<PlanState | null>(null);

  // Initialize backend and load state
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    getBackend().then((backend) => {
      if (cancelled) { backend.destroy(); return; }
      backendRef.current = backend;

      const rowSync = createRowSync({
        push: (ops) => backend.push(ops),
        onError: (errors) => {
          const msg = errors.map((e) => e.message).join('; ');
          setError(msg);
        },
      });
      rowSyncRef.current = rowSync;

      backend.load().then((loaded) => {
        if (cancelled) return;
        setStateRaw(loaded);
        baselineRef.current = loaded;
        setConnection(backend.connection);
        setRole(backend.role);
        setPersonId(backend.personId);
      }).catch((err: Error) => {
        if (cancelled) return;
        if (err.message === 'not_a_member') {
          setConnection('error');
          setError('not_a_member');
        } else {
          setConnection('error');
          setError(err.message);
        }
      });

      // Subscribe to inbound changes (no-op in LOCAL mode)
      unsub = backend.subscribe((inbound) => {
        setStateRaw(inbound);
        baselineRef.current = inbound;
      });
    });

    // Flush on pagehide and visibilitychange → hidden
    const onPageHide = () => rowSyncRef.current?.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') rowSyncRef.current?.flush();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      unsub?.();
      rowSyncRef.current?.destroy();
      backendRef.current?.destroy();
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Persist to localStorage and queue row diffs on every state change
  useEffect(() => {
    if (!state || !baselineRef.current) return;

    // Always persist locally (both modes keep a local cache)
    saveState(state);

    // Diff against baseline and queue ops
    const baseline = baselineRef.current;
    const ops = diffAll(
      { days: baseline.days, people: baseline.people, tasks: baseline.tasks, assignments: baseline.assignments },
      { days: state.days, people: state.people, tasks: state.tasks, assignments: state.assignments },
    );

    if (ops.length > 0 && rowSyncRef.current) {
      for (const op of ops) {
        rowSyncRef.current.queue(op);
      }
    }

    // Advance baseline so next diff is incremental
    baselineRef.current = state;
  }, [state]);

  // Wrapper that flushes before bulk replacements
  const setState: React.Dispatch<React.SetStateAction<PlanState>> = useCallback(
    (action) => {
      setStateRaw((prev) => {
        if (!prev) return prev;
        const next = typeof action === 'function' ? action(prev) : action;
        return next;
      });
    },
    [],
  );

  // Atomic full-plan replacement — uses the backend's replacePlan RPC in REMOTE mode.
  // This avoids the FK ordering issues that row-level diffs cause.
  const replacePlan = useCallback(async (newState: PlanState) => {
    // Flush any pending row writes first
    await rowSyncRef.current?.flush();

    const backend = backendRef.current;
    if (backend) {
      const err = await backend.replacePlan(newState);
      if (err) {
        setError(err.message);
        return;
      }
    }

    // Update local state and baseline so the next diff doesn't re-send everything
    setStateRaw(newState);
    baselineRef.current = newState;
    saveState(newState);
  }, []);

  // Return a loading state while the backend hasn't loaded yet
  if (!state) {
    return {
      state: { version: 1, eventName: '', days: [], people: [], tasks: [], assignments: [], rules: {} as PlanState['rules'] },
      setState,
      replacePlan,
      connection: 'connecting',
      canEdit: false,
      role: null,
      personId: null,
      error: null,
      setError,
    };
  }

  // In LOCAL mode (role=organizer), always editable.
  // In REMOTE mode, only organizers can edit, and only when the connection is live.
  const canEdit = role === 'organizer' && (connection === 'local' || connection === 'live');

  return { state, setState, replacePlan, connection, canEdit, role, personId, error, setError };
}
