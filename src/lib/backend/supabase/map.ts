/**
 * Row mappers: DB rows ↔ PlanState domain objects.
 *
 * DB uses snake_case; PlanState uses camelCase. This module is the single
 * translation boundary. It never touches the network.
 */

import type { Assignment, EventDay, Person, Task } from '../../../types';
import type { RowOp } from '../types';
import { assignmentKey, parseAssignmentKey } from '../diff';

// ---------------------------------------------------------------- DB → Domain

export interface DbDay {
  plan_id: string;
  id: string;
  label: string;
  date: string;
  offered_to_volunteers: boolean;
  sort_order: number;
  updated_at: string;
}

/**
 * NOTE: `notes` is deliberately absent. It lives in the organizer-only
 * `person_notes` table (migration 0004) and never travels on a `people` row —
 * not over REST, not over realtime. See dbPersonToDomain below.
 */
export interface DbPerson {
  plan_id: string;
  id: string;
  name: string;
  is_organizer: boolean;
  available_day_ids: string[];
  multi_shift: boolean;
  max_shifts: number | null;
  tags: string[];
  updated_at: string;
}

export interface DbPersonNote {
  plan_id: string;
  person_id: string;
  notes: string | null;
  updated_at: string;
}

export interface DbTask {
  plan_id: string;
  id: string;
  day_id: string;
  start_min: number;
  end_min: number;
  title: string;
  category: string;
  needed: number;
  notes: string | null;
  updated_at: string;
}

export interface DbAssignment {
  plan_id: string;
  task_id: string;
  person_id: string;
  pinned: boolean;
  source: string;
  updated_at: string;
}

export function dbDayToDomain(row: DbDay): EventDay {
  return {
    id: row.id,
    label: row.label,
    date: row.date,
    offeredToVolunteers: row.offered_to_volunteers,
  };
}

/**
 * Returns a Person WITHOUT `notes` — the column does not exist on the row.
 * Callers merging this into existing state must carry the local `notes`
 * forward themselves (see mergePeople), otherwise an unrelated realtime
 * update would blank an organizer's notes until the next reload.
 */
export function dbPersonToDomain(row: DbPerson): Person {
  return {
    id: row.id,
    name: row.name,
    isOrganizer: row.is_organizer,
    availableDayIds: row.available_day_ids ?? [],
    multiShift: row.multi_shift,
    maxShifts: row.max_shifts,
    tags: (row.tags ?? []) as Person['tags'],
  };
}

export function dbTaskToDomain(row: DbTask): Task {
  return {
    id: row.id,
    dayId: row.day_id,
    start: row.start_min,
    end: row.end_min,
    title: row.title,
    category: row.category as Task['category'],
    needed: row.needed,
    notes: row.notes ?? undefined,
  };
}

export function dbAssignmentToDomain(row: DbAssignment): Assignment {
  return {
    taskId: row.task_id,
    personId: row.person_id,
    pinned: row.pinned,
    source: row.source as Assignment['source'],
  };
}

// ---------------------------------------------------------------- Domain → DB (for row writes)

export function domainDayToDb(day: EventDay, planId: string): Record<string, unknown> {
  return {
    plan_id: planId,
    id: day.id,
    label: day.label,
    date: day.date,
    offered_to_volunteers: day.offeredToVolunteers,
  };
}

/** `notes` is intentionally not written here — see domainPersonNoteToDb. */
export function domainPersonToDb(person: Person, planId: string): Record<string, unknown> {
  return {
    plan_id: planId,
    id: person.id,
    name: person.name,
    is_organizer: person.isOrganizer,
    available_day_ids: person.availableDayIds,
    multi_shift: person.multiShift,
    max_shifts: person.maxShifts,
    tags: person.tags,
  };
}

/** Row for the organizer-only `person_notes` table. */
export function domainPersonNoteToDb(person: Person, planId: string): Record<string, unknown> {
  return {
    plan_id: planId,
    person_id: person.id,
    notes: person.notes ?? null,
  };
}

export function domainTaskToDb(task: Task, planId: string): Record<string, unknown> {
  return {
    plan_id: planId,
    id: task.id,
    day_id: task.dayId,
    start_min: task.start,
    end_min: task.end,
    title: task.title,
    category: task.category,
    needed: task.needed,
    notes: task.notes ?? null,
  };
}

export function domainAssignmentToDb(assignment: Assignment, planId: string): Record<string, unknown> {
  return {
    plan_id: planId,
    task_id: assignment.taskId,
    person_id: assignment.personId,
    pinned: assignment.pinned,
    source: assignment.source,
  };
}

// ---------------------------------------------------------------- RowOp → DB payload

const TABLE_MAP: Record<string, string> = {
  days: 'days',
  people: 'people',
  tasks: 'tasks',
  assignments: 'assignments',
};

export function rowOpToTable(op: RowOp): string {
  return TABLE_MAP[op.collection] ?? op.collection;
}

export function rowOpToDbPayload(op: RowOp, planId: string): Record<string, unknown> | null {
  if (op.type === 'delete') return null;
  const payload = op.payload;
  if (!payload) return null;

  switch (op.collection) {
    case 'days':
      return domainDayToDb(payload as unknown as EventDay, planId);
    case 'people':
      return domainPersonToDb(payload as unknown as Person, planId);
    case 'tasks':
      return domainTaskToDb(payload as unknown as Task, planId);
    case 'assignments':
      return domainAssignmentToDb(payload as unknown as Assignment, planId);
    default:
      return null;
  }
}

export function rowOpToDeleteMatch(op: RowOp, planId: string): Record<string, unknown> {
  const base: Record<string, unknown> = { plan_id: planId };
  if (op.collection === 'assignments') {
    const { taskId, personId } = parseAssignmentKey(op.id);
    return { ...base, task_id: taskId, person_id: personId };
  }
  return { ...base, id: op.id };
}

/** Extract the row ID from a realtime payload (for clock tracking). */
export function realtimeRowId(collection: string, row: Record<string, unknown>): string {
  if (collection === 'assignments') {
    return assignmentKey(row.task_id as string, row.person_id as string);
  }
  return row.id as string;
}
