/**
 * Mapping from spreadsheet rows onto the domain model.
 *
 * Deliberately ignores the identifying columns of the Google Form response sheet
 * (address, date of birth, phone, email). Scheduling never needs them, so they are
 * dropped at the boundary and never reach application state or localStorage.
 */

import type { EventDay, Person, Task, TaskCategory } from '../types';
import { parseTimeRange } from './time';

/** Columns we refuse to import, matched case-insensitively against the header. */
const PII_HEADERS = [/^address$/i, /date of birth/i, /^phone/i, /^e-?mail/i, /whatsapp/i];

export function isPiiHeader(header: string): boolean {
  return PII_HEADERS.some((re) => re.test(header.trim()));
}

const DAY_NAME_RE = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi;

/**
 * Pull day names out of a free-text answer.
 * Handles the Form's comma-in-value quirk: "Tuesday, 29th September, Wednesday, 30th September".
 */
export function matchDayIds(text: string, days: readonly EventDay[]): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(DAY_NAME_RE)) {
    const name = m[1].toLowerCase();
    const day = days.find((d) => d.label.toLowerCase() === name);
    if (day) found.add(day.id);
  }
  return days.filter((d) => found.has(d.id)).map((d) => d.id);
}

export function isYes(text: string): boolean {
  return /^(yes|ja|y|true|x)$/i.test((text ?? '').trim());
}

/** Order matters: the earlier patterns win for titles like "Registration setup". */
const CATEGORY_RULES: [RegExp, TaskCategory][] = [
  [/dismantl|teardown|tear.down|abbau/i, 'teardown'],
  [/deliver|pick.?up|shuttle|transport|logisti/i, 'logistics'],
  [/setup|set.up|aufbau/i, 'setup'],
  [/room.*host/i, 'roomHost'],
  [/room.*help|room.*support/i, 'roomHelp'],
  [/registration|check.?in/i, 'registration'],
  [/wildcard|floater/i, 'wildcard'],
  [/video|interview|photo|social|media/i, 'media'],
];

export function inferCategory(title: string): TaskCategory {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(title)) return cat;
  return 'other';
}

/**
 * Collision-free id.
 *
 * Deliberately not `Date.now()` + a per-page counter: the counter only separates
 * calls within one page, so two clients minting an id in the same millisecond
 * would produce the same value. Full UUID rather than a truncated one — cutting
 * it to 8 hex chars reintroduces a birthday collision for no benefit.
 */
export function newId(prefix: string): string {
  return `${prefix}-${randomId()}`;
}

function randomId(): string {
  const c = globalThis.crypto;
  // randomUUID needs a secure context; getRandomValues does not, which matters
  // if the built app is ever served over plain http on a LAN address.
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function headerIndex(header: string[], ...patterns: RegExp[]): number {
  for (const re of patterns) {
    const i = header.findIndex((h) => re.test((h ?? '').trim()));
    if (i !== -1) return i;
  }
  return -1;
}

export interface ImportReport {
  added: number;
  skipped: number;
  messages: string[];
  droppedColumns: string[];
}

/** Import the "Tasks" sheet: Day | Time | Task | Needed | ... */
export function importTasks(rows: string[][], days: readonly EventDay[]): { tasks: Task[]; report: ImportReport } {
  const report: ImportReport = { added: 0, skipped: 0, messages: [], droppedColumns: [] };
  const tasks: Task[] = [];
  if (rows.length < 2) {
    report.messages.push('Sheet has no data rows.');
    return { tasks, report };
  }

  const header = rows[0];
  const cDay = headerIndex(header, /^day$/i, /^tag$/i);
  const cTime = headerIndex(header, /^time$/i, /^zeit$/i);
  const cTitle = headerIndex(header, /^task$/i, /^aufgabe$/i, /^description$/i);
  const cNeeded = headerIndex(header, /needed/i, /^count$/i, /benötigt/i);

  if (cDay === -1 || cTime === -1 || cTitle === -1) {
    report.messages.push('Could not find Day / Time / Task columns — is this the Tasks sheet?');
    return { tasks, report };
  }

  for (const row of rows.slice(1)) {
    const title = (row[cTitle] ?? '').trim();
    if (!title) {
      report.skipped++;
      continue;
    }
    const dayIds = matchDayIds(row[cDay] ?? '', days);
    const range = parseTimeRange(row[cTime] ?? '');
    if (dayIds.length === 0) {
      report.skipped++;
      report.messages.push(`"${title}": unrecognised day "${row[cDay]}".`);
      continue;
    }
    if (!range) {
      report.skipped++;
      report.messages.push(`"${title}": could not read time "${row[cTime]}".`);
      continue;
    }
    const needed = Math.max(1, Number.parseInt(row[cNeeded] ?? '1', 10) || 1);
    tasks.push({
      id: newId('t'),
      dayId: dayIds[0],
      start: range.start,
      end: range.end,
      title,
      category: inferCategory(title),
      needed,
    });
    report.added++;
  }
  return { tasks, report };
}

/**
 * Import Google Form responses. Only Name, availability days and the multi-shift
 * answer are read; identifying columns are reported as dropped.
 */
export function importFormResponses(
  rows: string[][],
  days: readonly EventDay[],
): { people: Person[]; report: ImportReport } {
  const report: ImportReport = { added: 0, skipped: 0, messages: [], droppedColumns: [] };
  const people: Person[] = [];
  if (rows.length < 2) {
    report.messages.push('Sheet has no data rows.');
    return { people, report };
  }

  const header = rows[0];
  report.droppedColumns = header.filter((h) => h && isPiiHeader(h));

  const cName = headerIndex(header, /^name$/i);
  const cDays = headerIndex(header, /help on the following days/i, /availab/i, /^days$/i);
  const cMulti = headerIndex(header, /more than one shift/i, /multiple (days|shifts)/i);

  if (cName === -1) {
    report.messages.push('No "Name" column found — is this the form responses sheet?');
    return { people, report };
  }

  for (const row of rows.slice(1)) {
    const name = (row[cName] ?? '').trim();
    if (!name) {
      report.skipped++;
      continue;
    }
    const availableDayIds = cDays === -1 ? days.map((d) => d.id) : matchDayIds(row[cDays] ?? '', days);
    if (availableDayIds.length === 0) {
      report.messages.push(`${name}: no recognisable availability, defaulting to none.`);
    }
    people.push({
      id: newId('p'),
      name,
      isOrganizer: false,
      availableDayIds,
      multiShift: cMulti === -1 ? true : isYes(row[cMulti] ?? ''),
      maxShifts: null,
      tags: [],
    });
    report.added++;
  }
  return { people, report };
}

/** Import the "Persons" sheet: Volunteer Name | Organizer | Availability Days | Multiple Days */
export function importPersons(
  rows: string[][],
  days: readonly EventDay[],
): { people: Person[]; report: ImportReport } {
  const report: ImportReport = { added: 0, skipped: 0, messages: [], droppedColumns: [] };
  const people: Person[] = [];
  if (rows.length < 2) return { people, report };

  const header = rows[0];
  const cName = headerIndex(header, /volunteer name/i, /^name$/i);
  const cOrg = headerIndex(header, /organi[sz]er/i);
  const cDays = headerIndex(header, /availab/i, /days/i);
  const cMulti = headerIndex(header, /multiple (days|shifts)/i, /more than one/i);

  if (cName === -1) {
    report.messages.push('No name column found — is this the Persons sheet?');
    return { people, report };
  }

  for (const row of rows.slice(1)) {
    const name = (row[cName] ?? '').trim();
    if (!name) {
      report.skipped++;
      continue;
    }
    people.push({
      id: newId('p'),
      name,
      isOrganizer: cOrg === -1 ? false : isYes(row[cOrg] ?? ''),
      availableDayIds: cDays === -1 ? days.map((d) => d.id) : matchDayIds(row[cDays] ?? '', days),
      multiShift: cMulti === -1 ? true : isYes(row[cMulti] ?? ''),
      maxShifts: null,
      tags: [],
    });
    report.added++;
  }
  return { people, report };
}

export type SheetKind = 'tasks' | 'persons' | 'formResponses' | 'unknown';

/** Guess what a sheet is so import can be one drag-and-drop with no questions asked. */
export function detectSheetKind(name: string, rows: string[][]): SheetKind {
  const header = (rows[0] ?? []).map((h) => (h ?? '').toLowerCase());
  const has = (re: RegExp) => header.some((h) => re.test(h));

  if (has(/timestamp/) && has(/^name$/)) return 'formResponses';
  if (has(/help on the following days/)) return 'formResponses';
  if (has(/^day$/) && has(/^time$/) && has(/^task$/)) return 'tasks';
  if (has(/volunteer name/) || (has(/organi[sz]er/) && has(/availab/))) return 'persons';
  if (/task/i.test(name)) return 'tasks';
  if (/person|volunteer/i.test(name)) return 'persons';
  return 'unknown';
}

/** Merge imported people into existing ones, matching on normalised name. */
export function mergePeople(
  existing: readonly Person[],
  incoming: readonly Person[],
): { people: Person[]; added: number; updated: number } {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const byName = new Map(existing.map((p) => [norm(p.name), p]));
  const people = existing.slice();
  let added = 0;
  let updated = 0;

  for (const inc of incoming) {
    const match = byName.get(norm(inc.name));
    if (match) {
      const idx = people.findIndex((p) => p.id === match.id);
      // Union of availability; keep an existing organizer flag and any tags already set.
      people[idx] = {
        ...match,
        availableDayIds: [...new Set([...match.availableDayIds, ...inc.availableDayIds])],
        multiShift: match.multiShift || inc.multiShift,
        isOrganizer: match.isOrganizer || inc.isOrganizer,
      };
      updated++;
    } else {
      people.push(inc);
      byName.set(norm(inc.name), inc);
      added++;
    }
  }
  return { people, added, updated };
}
