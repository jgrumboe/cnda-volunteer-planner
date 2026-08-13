/** Derived views over PlanState. Nothing here is stored — it is all recomputed. */

import { CATEGORY_META, type Assignment, type PlanState, type Person, type Task } from '../types';
import { durationHours, overlaps } from './time';

export function taskRange(t: Task) {
  return { start: t.start, end: t.end };
}

export function taskHours(t: Task): number {
  return durationHours(taskRange(t));
}

export function isAllHands(t: Task): boolean {
  return CATEGORY_META[t.category].allHands;
}

export interface PersonLoad {
  personId: string;
  shifts: number;
  hours: number;
  /** dayId -> number of assignments (all categories). */
  perDay: Record<string, number>;
  /** dayId -> number of regular (non all-hands) assignments. */
  regularPerDay: Record<string, number>;
  /** category -> count. */
  perCategory: Record<string, number>;
}

export function emptyLoad(personId: string): PersonLoad {
  return { personId, shifts: 0, hours: 0, perDay: {}, regularPerDay: {}, perCategory: {} };
}

export function computeLoads(
  people: readonly Person[],
  tasks: readonly Task[],
  assignments: readonly Assignment[],
): Map<string, PersonLoad> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const loads = new Map(people.map((p) => [p.id, emptyLoad(p.id)]));
  for (const a of assignments) {
    const task = byId.get(a.taskId);
    const load = loads.get(a.personId);
    if (!task || !load) continue;
    load.shifts += 1;
    load.hours += taskHours(task);
    load.perDay[task.dayId] = (load.perDay[task.dayId] ?? 0) + 1;
    if (!isAllHands(task)) {
      load.regularPerDay[task.dayId] = (load.regularPerDay[task.dayId] ?? 0) + 1;
    }
    load.perCategory[task.category] = (load.perCategory[task.category] ?? 0) + 1;
  }
  return loads;
}

/**
 * Drop assignments whose person or task no longer exists.
 *
 * Deleting a person or task must cascade: a leftover assignment still counts
 * toward the task's head count, so the board would show a slot filled by
 * somebody who isn't in the plan any more.
 *
 * Returns the identical `assignments` array reference when nothing cascades, so
 * downstream memos keyed on it are not invalidated on every unrelated edit.
 */
export function withPrunedAssignments(state: PlanState): PlanState {
  const peopleIds = new Set(state.people.map((p) => p.id));
  const taskIds = new Set(state.tasks.map((t) => t.id));
  const kept = state.assignments.filter(
    (a) => peopleIds.has(a.personId) && taskIds.has(a.taskId),
  );
  return kept.length === state.assignments.length ? state : { ...state, assignments: kept };
}

export function assignedCount(assignments: readonly Assignment[], taskId: string): number {
  let n = 0;
  for (const a of assignments) if (a.taskId === taskId) n++;
  return n;
}

export function assigneesOf(assignments: readonly Assignment[], taskId: string): Assignment[] {
  return assignments.filter((a) => a.taskId === taskId);
}

export function tasksOfPerson(
  tasks: readonly Task[],
  assignments: readonly Assignment[],
  personId: string,
): Task[] {
  const ids = new Set(assignments.filter((a) => a.personId === personId).map((a) => a.taskId));
  return tasks.filter((t) => ids.has(t.id));
}

export type ConflictKind = 'overlap' | 'unavailable' | 'overCapacity' | 'multiShift' | 'dayLimit';

export interface Conflict {
  kind: ConflictKind;
  message: string;
  personId?: string;
  taskId?: string;
}

/** Validate the current plan and describe everything that is wrong with it. */
export function findConflicts(state: PlanState): Conflict[] {
  const out: Conflict[] = [];
  const { people, tasks, assignments, rules } = state;
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const personById = new Map(people.map((p) => [p.id, p]));

  for (const t of tasks) {
    const n = assignedCount(assignments, t.id);
    if (n > t.needed) {
      out.push({
        kind: 'overCapacity',
        taskId: t.id,
        message: `"${t.title}" has ${n} people but only needs ${t.needed}.`,
      });
    }
  }

  for (const p of people) {
    const mine = tasksOfPerson(tasks, assignments, p.id);

    for (const t of mine) {
      if (!p.availableDayIds.includes(t.dayId)) {
        const day = state.days.find((d) => d.id === t.dayId);
        out.push({
          kind: 'unavailable',
          personId: p.id,
          taskId: t.id,
          message: `${p.name} is assigned to "${t.title}" but is not available on ${day?.label ?? t.dayId}.`,
        });
      }
    }

    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        if (mine[i].dayId === mine[j].dayId && overlaps(taskRange(mine[i]), taskRange(mine[j]))) {
          out.push({
            kind: 'overlap',
            personId: p.id,
            taskId: mine[i].id,
            message: `${p.name} is double-booked: "${mine[i].title}" overlaps "${mine[j].title}".`,
          });
        }
      }
    }

    if (rules.respectMultiShift && !p.multiShift && mine.length > 1) {
      out.push({
        kind: 'multiShift',
        personId: p.id,
        message: `${p.name} asked for a single shift but has ${mine.length}.`,
      });
    }
    if (p.maxShifts !== null && mine.length > p.maxShifts) {
      out.push({
        kind: 'multiShift',
        personId: p.id,
        message: `${p.name} is over their cap of ${p.maxShifts} shifts (${mine.length}).`,
      });
    }

    const exempt = rules.organizersExemptFromDayLimit && p.isOrganizer;
    if (rules.oneShiftPerDay && !exempt) {
      const perDay = new Map<string, Task[]>();
      for (const t of mine) {
        if (rules.allHandsExempt && isAllHands(t)) continue;
        const list = perDay.get(t.dayId) ?? [];
        list.push(t);
        perDay.set(t.dayId, list);
      }
      for (const [dayId, list] of perDay) {
        if (list.length > 1) {
          const day = state.days.find((d) => d.id === dayId);
          out.push({
            kind: 'dayLimit',
            personId: p.id,
            message: `${p.name} has ${list.length} regular shifts on ${day?.label ?? dayId} (limit is 1).`,
          });
        }
      }
    }
  }

  for (const a of assignments) {
    if (!taskById.has(a.taskId) || !personById.has(a.personId)) {
      out.push({ kind: 'overCapacity', message: 'Orphaned assignment referencing a deleted task or person.' });
    }
  }

  return out;
}

export interface CoverageRow {
  task: Task;
  assigned: number;
  missing: number;
}

export function coverage(state: PlanState): CoverageRow[] {
  return state.tasks.map((task) => {
    const assigned = assignedCount(state.assignments, task.id);
    return { task, assigned, missing: Math.max(0, task.needed - assigned) };
  });
}

export function totalOpenSlots(state: PlanState): number {
  return coverage(state).reduce((sum, r) => sum + r.missing, 0);
}
