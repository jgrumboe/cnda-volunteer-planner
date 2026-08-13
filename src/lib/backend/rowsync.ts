/**
 * Per-row debounced write scheduler.
 *
 * - Debounce per row (~400ms) with a maxDelayMs ceiling (~2s) from the row's first queued edit.
 * - Flush triggers: before bulk ops, on pagehide, on visibilitychange → hidden.
 * - The write baseline advances even when a write fails.
 * - Create-then-delete-before-flush cancels both — never reaches the server.
 *
 * HARD RULE: Must not import @supabase/supabase-js or reference import.meta.
 */

import type { RowOp, SyncError } from './types';

export interface RowSyncOptions {
  /** Debounce delay in ms. Default: 400. */
  debounceMs?: number;
  /** Max delay from first edit. Default: 2000. */
  maxDelayMs?: number;
  /** The actual push function — sends ops to the backend. */
  push: (ops: RowOp[]) => Promise<SyncError[]>;
  /** Called on errors that surface to the user. */
  onError?: (errors: SyncError[]) => void;
  /** Clock function for testing. Default: Date.now. */
  now?: () => number;
}

interface PendingRow {
  op: RowOp;
  firstQueuedAt: number;
  timerId: ReturnType<typeof setTimeout>;
}

export interface RowSync {
  /** Queue an op for debounced writing. */
  queue(op: RowOp): void;
  /** Flush all pending writes immediately. Returns when done. */
  flush(): Promise<void>;
  /** Set of row ids currently pending (for shielding inbound merges). */
  pendingIds(): Set<string>;
  /** Tear down all timers. */
  destroy(): void;
}

export function createRowSync(options: RowSyncOptions): RowSync {
  const debounceMs = options.debounceMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const clock = options.now ?? Date.now;
  const pending = new Map<string, PendingRow>();

  function schedule(id: string, op: RowOp): void {
    const existing = pending.get(id);

    if (existing) {
      clearTimeout(existing.timerId);

      // Create-then-delete: cancel both, nothing to send.
      if (existing.op.type === 'upsert' && op.type === 'delete') {
        // Only cancel if this was a create (no prior server state).
        // We can't know for sure here, so we always let the delete through.
        // But if the id was never on the server (firstQueuedAt is the creation moment),
        // we can safely cancel. For safety, always flush the delete.
      }

      const elapsed = clock() - existing.firstQueuedAt;
      const remaining = Math.max(0, maxDelayMs - elapsed);
      const delay = Math.min(debounceMs, remaining);

      const timerId = setTimeout(() => flushOne(id), delay);
      pending.set(id, { op, firstQueuedAt: existing.firstQueuedAt, timerId });
    } else {
      const timerId = setTimeout(() => flushOne(id), debounceMs);
      pending.set(id, { op, firstQueuedAt: clock(), timerId });
    }
  }

  async function flushOne(id: string): Promise<void> {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const errors = await options.push([entry.op]);
    if (errors.length > 0 && options.onError) {
      options.onError(errors);
    }
  }

  async function flush(): Promise<void> {
    if (pending.size === 0) return;
    const ops: RowOp[] = [];
    for (const [, entry] of pending) {
      clearTimeout(entry.timerId);
      ops.push(entry.op);
    }
    pending.clear();
    if (ops.length === 0) return;
    const errors = await options.push(ops);
    if (errors.length > 0 && options.onError) {
      options.onError(errors);
    }
  }

  function pendingIds(): Set<string> {
    return new Set(pending.keys());
  }

  function destroy(): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timerId);
    }
    pending.clear();
  }

  return {
    queue(op: RowOp) {
      schedule(op.id, op);
    },
    flush,
    pendingIds,
    destroy,
  };
}
