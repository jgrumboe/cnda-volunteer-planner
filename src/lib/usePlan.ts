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
  connection: ConnectionState;
  error: string | null;
  setError: (err: string | null) => void;
}

export function usePlan(): UsePlanResult {
  const [state, setStateRaw] = useState<PlanState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);

  const backendRef = useRef<PlanBackend | null>(null);
  const rowSyncRef = useRef<RowSync | null>(null);
  const baselineRef = useRef<PlanState | null>(null);

  // Initialize backend and load state
  useEffect(() => {
    const backend = getBackend();
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
      setStateRaw(loaded);
      baselineRef.current = loaded;
      setConnection(backend.connection);
    });

    // Subscribe to inbound changes (no-op in LOCAL mode)
    const unsub = backend.subscribe((inbound) => {
      setStateRaw(inbound);
      baselineRef.current = inbound;
    });

    // Flush on pagehide and visibilitychange → hidden
    const onPageHide = () => rowSync.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') rowSync.flush();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsub();
      rowSync.destroy();
      backend.destroy();
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

  // Return a loading state while the backend hasn't loaded yet
  if (!state) {
    return {
      state: { version: 1, eventName: '', days: [], people: [], tasks: [], assignments: [], rules: {} as PlanState['rules'] },
      setState,
      connection: 'connecting',
      error: null,
      setError,
    };
  }

  return { state, setState, connection, error, setError };
}
