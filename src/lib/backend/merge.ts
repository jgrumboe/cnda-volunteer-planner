/**
 * Inbound merge: apply remote changes to local state with identity preservation.
 *
 * Key properties:
 * - An upsert that shallowRowEqual matches the local row returns the SAME state reference.
 * - An upsert of an unknown id returns a new state with only the affected array replaced.
 * - A delete of an absent id returns the SAME state reference.
 * - Rows with pending local writes are shielded (upserts dropped), but deletes are NEVER shielded.
 *
 * HARD RULE: Must not import @supabase/supabase-js or reference import.meta.
 */

import type { Assignment, EventDay, Person, PlanState, Task } from '../../types';
import type { RowCollection, RowClocks } from './types';
import { assignmentKey, shallowRowEqual } from './diff';

// ---------------------------------------------------------------- types

export interface InboundEvent {
  collection: RowCollection;
  type: 'upsert' | 'delete';
  id: string;
  payload?: Record<string, unknown>;
  /** Server timestamp for clock comparison. */
  timestamp?: string;
}

export interface MergeOptions {
  /** Set of row ids currently shielded by pending local writes. */
  pendingIds?: Set<string>;
  /** Per-collection clocks for stale-event detection. */
  clocks?: Record<RowCollection, RowClocks>;
}

// ---------------------------------------------------------------- merge

export function mergeInbound(
  state: PlanState,
  event: InboundEvent,
  options: MergeOptions = {},
): PlanState {
  const { pendingIds, clocks } = options;

  // Never shield deletes — they are authoritative.
  if (event.type === 'upsert' && pendingIds?.has(event.id)) {
    return state;
  }

  // Stale event check: if we have a clock for this row and the event is older, drop it.
  if (event.type === 'upsert' && event.timestamp && clocks) {
    const collectionClocks = clocks[event.collection];
    const localTs = collectionClocks?.get(event.id);
    if (localTs && event.timestamp <= localTs) {
      return state;
    }
  }

  switch (event.collection) {
    case 'days':
      return mergeDays(state, event);
    case 'people':
      return mergePeople(state, event);
    case 'tasks':
      return mergeTasks(state, event);
    case 'assignments':
      return mergeAssignments(state, event);
    default:
      return state;
  }
}

// ---------------------------------------------------------------- per-collection mergers

function mergeDays(state: PlanState, event: InboundEvent): PlanState {
  if (event.type === 'delete') {
    const idx = state.days.findIndex((d) => d.id === event.id);
    if (idx === -1) return state;
    const days = [...state.days];
    days.splice(idx, 1);
    return { ...state, days };
  }
  // Upsert
  const incoming = event.payload as unknown as EventDay;
  const idx = state.days.findIndex((d) => d.id === event.id);
  if (idx !== -1) {
    if (shallowRowEqual(state.days[idx] as unknown as Record<string, unknown>, incoming as unknown as Record<string, unknown>)) {
      return state;
    }
    const days = [...state.days];
    days[idx] = incoming;
    return { ...state, days };
  }
  return { ...state, days: [...state.days, incoming] };
}

function mergePeople(state: PlanState, event: InboundEvent): PlanState {
  if (event.type === 'delete') {
    const idx = state.people.findIndex((p) => p.id === event.id);
    if (idx === -1) return state;
    const people = [...state.people];
    people.splice(idx, 1);
    return { ...state, people };
  }
  const incoming = event.payload as unknown as Person;
  const idx = state.people.findIndex((p) => p.id === event.id);
  if (idx !== -1) {
    if (shallowRowEqual(state.people[idx] as unknown as Record<string, unknown>, incoming as unknown as Record<string, unknown>)) {
      return state;
    }
    const people = [...state.people];
    people[idx] = incoming;
    return { ...state, people };
  }
  return { ...state, people: [...state.people, incoming] };
}

function mergeTasks(state: PlanState, event: InboundEvent): PlanState {
  if (event.type === 'delete') {
    const idx = state.tasks.findIndex((t) => t.id === event.id);
    if (idx === -1) return state;
    const tasks = [...state.tasks];
    tasks.splice(idx, 1);
    return { ...state, tasks };
  }
  const incoming = event.payload as unknown as Task;
  const idx = state.tasks.findIndex((t) => t.id === event.id);
  if (idx !== -1) {
    if (shallowRowEqual(state.tasks[idx] as unknown as Record<string, unknown>, incoming as unknown as Record<string, unknown>)) {
      return state;
    }
    const tasks = [...state.tasks];
    tasks[idx] = incoming;
    return { ...state, tasks };
  }
  return { ...state, tasks: [...state.tasks, incoming] };
}

function mergeAssignments(state: PlanState, event: InboundEvent): PlanState {
  if (event.type === 'delete') {
    const idx = state.assignments.findIndex(
      (a) => assignmentKey(a.taskId, a.personId) === event.id,
    );
    if (idx === -1) return state;
    const assignments = [...state.assignments];
    assignments.splice(idx, 1);
    return { ...state, assignments };
  }
  const incoming = event.payload as unknown as Assignment;
  const key = assignmentKey(incoming.taskId, incoming.personId);
  const idx = state.assignments.findIndex(
    (a) => assignmentKey(a.taskId, a.personId) === key,
  );
  if (idx !== -1) {
    if (shallowRowEqual(state.assignments[idx] as unknown as Record<string, unknown>, incoming as unknown as Record<string, unknown>)) {
      return state;
    }
    const assignments = [...state.assignments];
    assignments[idx] = incoming;
    return { ...state, assignments };
  }
  return { ...state, assignments: [...state.assignments, incoming] };
}
