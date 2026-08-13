/** CSV / JSON export. Excel and Google Sheets both open the CSVs directly. */

import { CATEGORY_META, type PlanState } from '../types';
import { assigneesOf, computeLoads, tasksOfPerson } from './plan';
import { downloadFile } from './storage';
import { fmtClock } from './time';
import { toCsv } from './xlsx';

function dayLabel(state: PlanState, dayId: string): string {
  const d = state.days.find((x) => x.id === dayId);
  return d ? d.label : dayId;
}

function sortedTasks(state: PlanState) {
  const order = new Map(state.days.map((d, i) => [d.id, i]));
  return state.tasks
    .slice()
    .sort((a, b) => (order.get(a.dayId) ?? 0) - (order.get(b.dayId) ?? 0) || a.start - b.start || a.title.localeCompare(b.title));
}

/** Mirrors the original spreadsheet layout, so it can be pasted back into Google Sheets. */
export function tasksCsv(state: PlanState): string {
  const byId = new Map(state.people.map((p) => [p.id, p]));
  const rows: (string | number)[][] = [
    ['Day', 'Date', 'Time', 'Task', 'Category', 'Needed', 'Assigned', 'Missing', 'Assigned Persons'],
  ];
  for (const t of sortedTasks(state)) {
    const names = assigneesOf(state.assignments, t.id)
      .map((a) => byId.get(a.personId)?.name ?? '?')
      .sort((a, b) => a.localeCompare(b));
    const day = state.days.find((d) => d.id === t.dayId);
    rows.push([
      dayLabel(state, t.dayId),
      day?.date ?? '',
      `${fmtClock(t.start)}-${fmtClock(t.end)}`,
      t.title,
      CATEGORY_META[t.category].label,
      t.needed,
      names.length,
      Math.max(0, t.needed - names.length),
      names.join(', '),
    ]);
  }
  return toCsv(rows);
}

/** One row per person, with their schedule per day — the view volunteers actually want. */
export function peopleCsv(state: PlanState): string {
  const loads = computeLoads(state.people, state.tasks, state.assignments);
  const header = [
    'Name',
    'Role',
    'Available Days',
    'Wants Multiple Shifts',
    'Shifts',
    'Hours',
    ...state.days.map((d) => `${d.label} ${d.date}`),
  ];
  const rows: (string | number)[][] = [header];

  for (const p of [...state.people].sort((a, b) => a.name.localeCompare(b.name))) {
    const load = loads.get(p.id);
    const mine = tasksOfPerson(state.tasks, state.assignments, p.id);
    const perDay = state.days.map((d) =>
      mine
        .filter((t) => t.dayId === d.id)
        .sort((a, b) => a.start - b.start)
        .map((t) => `${fmtClock(t.start)}-${fmtClock(t.end)} ${t.title}`)
        .join('\n'),
    );
    rows.push([
      p.name,
      p.isOrganizer ? 'Organizer' : 'Volunteer',
      p.availableDayIds.map((id) => dayLabel(state, id)).join(', '),
      p.multiShift ? 'Yes' : 'No',
      load?.shifts ?? 0,
      (load?.hours ?? 0).toFixed(1),
      ...perDay,
    ]);
  }
  return toCsv(rows);
}

export function exportTasksCsv(state: PlanState): void {
  downloadFile(`${slug(state.eventName)}-tasks.csv`, tasksCsv(state), 'text/csv');
}

export function exportPeopleCsv(state: PlanState): void {
  downloadFile(`${slug(state.eventName)}-people.csv`, peopleCsv(state), 'text/csv');
}

export function exportJson(state: PlanState): void {
  downloadFile(`${slug(state.eventName)}-plan.json`, JSON.stringify(state, null, 2), 'application/json');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'plan';
}
