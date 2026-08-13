/** Local persistence. Nothing leaves the browser. */

import { DEFAULT_RULES, type PlanState } from '../types';

const KEY = 'cnda-planner:v1';
export const STATE_VERSION = 1;

export function loadState(): PlanState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlanState;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return normalize(parsed);
  } catch (err) {
    console.warn('Could not read saved plan, starting fresh.', err);
    return null;
  }
}

export function saveState(state: PlanState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save plan.', err);
  }
}

export function clearState(): void {
  localStorage.removeItem(KEY);
}

/** Fill in anything a older/hand-edited file is missing so the UI never sees undefined. */
export function normalize(s: Partial<PlanState>): PlanState {
  return {
    version: STATE_VERSION,
    eventName: s.eventName ?? 'Cloud Native Days Austria',
    days: s.days ?? [],
    people: (s.people ?? []).map((p) => ({
      ...p,
      availableDayIds: p.availableDayIds ?? [],
      tags: p.tags ?? [],
      maxShifts: p.maxShifts ?? null,
      multiShift: p.multiShift ?? false,
      isOrganizer: p.isOrganizer ?? false,
    })),
    tasks: s.tasks ?? [],
    assignments: (s.assignments ?? []).map((a) => ({
      ...a,
      pinned: a.pinned ?? true,
      source: a.source ?? 'imported',
    })),
    rules: { ...DEFAULT_RULES, ...(s.rules ?? {}) },
  };
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
