/**
 * Row-level diffing for the sync layer.
 *
 * HARD RULE: Must not import @supabase/supabase-js or reference import.meta.
 */

import type { Assignment, EventDay, Person, Task } from '../../types';
import type { RowOp, RowCollection } from './types';

// ---------------------------------------------------------------- assignment key

/** Composite identity for assignments: (taskId, personId). */
export function assignmentKey(taskId: string, personId: string): string {
  return `${taskId}::${personId}`;
}

export function parseAssignmentKey(key: string): { taskId: string; personId: string } {
  const idx = key.indexOf('::');
  return { taskId: key.slice(0, idx), personId: key.slice(idx + 2) };
}

// ---------------------------------------------------------------- shallow equality

/**
 * Shallow equality that handles string[] fields elementwise.
 * `availableDayIds` and `tags` get fresh array instances on every toggle,
 * so reference comparison would always report a change.
 */
export function shallowRowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    // Compare arrays elementwise
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- diffById

export interface DiffResult {
  ops: RowOp[];
  /** True if the arrays are identical (no ops needed). */
  unchanged: boolean;
}

/**
 * Diff two arrays of rows by id, producing upsert/delete ops.
 * `getId` extracts the identity from each row.
 */
export function diffById<T>(
  prev: T[],
  next: T[],
  collection: RowCollection,
  getId: (row: T) => string,
): DiffResult {
  const ops: RowOp[] = [];
  const prevMap = new Map(prev.map((r) => [getId(r), r]));
  const nextMap = new Map(next.map((r) => [getId(r), r]));

  // Upserts: new or changed rows
  for (const [id, row] of nextMap) {
    const old = prevMap.get(id);
    if (!old || !shallowRowEqual(old as unknown as Record<string, unknown>, row as unknown as Record<string, unknown>)) {
      ops.push({ collection, type: 'upsert', id, payload: row as unknown as Record<string, unknown> });
    }
  }

  // Deletes: rows in prev but not in next
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) {
      ops.push({ collection, type: 'delete', id });
    }
  }

  return { ops, unchanged: ops.length === 0 };
}

// ---------------------------------------------------------------- convenience diffAll

export interface PlanArrays {
  days: EventDay[];
  people: Person[];
  tasks: Task[];
  assignments: Assignment[];
}

/**
 * Diff all four collections between prev and next state.
 * Returns combined ops (may be empty if nothing changed).
 */
export function diffAll(prev: PlanArrays, next: PlanArrays): RowOp[] {
  const ops: RowOp[] = [];

  const dayDiff = diffById(prev.days, next.days, 'days', (d) => d.id);
  const peopleDiff = diffById(prev.people, next.people, 'people', (p) => p.id);
  const taskDiff = diffById(prev.tasks, next.tasks, 'tasks', (t) => t.id);
  const assignDiff = diffById(
    prev.assignments,
    next.assignments,
    'assignments',
    (a) => assignmentKey(a.taskId, a.personId),
  );

  ops.push(...dayDiff.ops, ...peopleDiff.ops, ...taskDiff.ops, ...assignDiff.ops);
  return ops;
}
