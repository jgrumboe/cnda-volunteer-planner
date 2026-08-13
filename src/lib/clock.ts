/**
 * Event-timezone clock and "now/next" selectors.
 *
 * Uses Intl.DateTimeFormat + formatToParts — no date library, no offset arithmetic,
 * handles DST transitions correctly. The `at` parameter makes every function
 * unit-testable without mocking globals.
 */

import type { PlanState, Task } from '../types';

export const EVENT_TZ = 'Europe/Vienna';

export interface WallClock {
  /** ISO date string, e.g. "2026-09-29" */
  date: string;
  /** Minutes from midnight in the event timezone */
  minutes: number;
}

/** Wall-clock "now" in the event's timezone. */
export function nowInEventTz(at: Date = new Date()): WallClock {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { date, minutes };
}

export type EventPhase = 'before' | 'during' | 'after' | 'between-days';

/** Determine where we are relative to the event days. */
export function eventPhase(state: PlanState, now: WallClock): EventPhase {
  if (state.days.length === 0) return 'before';

  const dates = state.days.map((d) => d.date).sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  if (now.date < firstDate) return 'before';
  if (now.date > lastDate) return 'after';

  // We're within the date range — check if it's an event day
  if (state.days.some((d) => d.date === now.date)) return 'during';

  // Between event days (e.g. a gap day)
  return 'between-days';
}

/** Tasks whose time range contains "now". Half-open: start <= now < end. */
export function runningNow(state: PlanState, now: WallClock, personId?: string): Task[] {
  const todayDayIds = state.days.filter((d) => d.date === now.date).map((d) => d.id);
  if (todayDayIds.length === 0) return [];

  let tasks = state.tasks.filter(
    (t) => todayDayIds.includes(t.dayId) && t.start <= now.minutes && now.minutes < t.end,
  );

  if (personId) {
    const assigned = new Set(
      state.assignments.filter((a) => a.personId === personId).map((a) => a.taskId),
    );
    tasks = tasks.filter((t) => assigned.has(t.id));
  }

  return tasks;
}

/** Next tasks starting after "now", sorted by start time. */
export function upNext(state: PlanState, now: WallClock, personId?: string): Task[] {
  const todayDayIds = state.days.filter((d) => d.date === now.date).map((d) => d.id);
  if (todayDayIds.length === 0) return [];

  let tasks = state.tasks.filter(
    (t) => todayDayIds.includes(t.dayId) && t.start > now.minutes,
  );

  if (personId) {
    const assigned = new Set(
      state.assignments.filter((a) => a.personId === personId).map((a) => a.taskId),
    );
    tasks = tasks.filter((t) => assigned.has(t.id));
  }

  return tasks.sort((a, b) => a.start - b.start);
}

/**
 * Tasks currently running that overlap with the given task.
 * Useful for showing "who else is on the same shift".
 */
export function coworkers(
  state: PlanState,
  taskId: string,
): { personId: string; name: string }[] {
  return state.assignments
    .filter((a) => a.taskId === taskId)
    .map((a) => {
      const person = state.people.find((p) => p.id === a.personId);
      return { personId: a.personId, name: person?.name ?? a.personId };
    });
}

/**
 * Parse a `?now=` query parameter into a Date.
 * Accepts ISO-ish formats like "2026-09-29T10:15" (interpreted as Europe/Vienna wall time
 * is impractical without a library, so we treat it as UTC for the override — close enough
 * for demo purposes since nowInEventTz will then convert it back to Vienna time).
 */
export function parseNowOverride(search: string): Date | null {
  const params = new URLSearchParams(search);
  const raw = params.get('now');
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}
