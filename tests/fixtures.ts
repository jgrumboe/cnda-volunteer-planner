/**
 * Synthetic fixture for the self-test suite only — never imported by app code.
 * Mirrors the shape of a real conference plan (3 days, 30-task template, 8
 * organizers + 10 volunteers with a realistic availability/multi-shift mix)
 * so the scheduling algorithms are exercised at realistic volume, without
 * any real person's name.
 */

import { DEFAULT_RULES, type EventDay, type PlanState, type Person, type Task } from '../src/types';
import { inferCategory } from '../src/lib/importers';
import { parseTimeRange } from '../src/lib/time';

export const DAYS: EventDay[] = [
  { id: 'mon', label: 'Monday', date: '2026-09-28', offeredToVolunteers: true },
  { id: 'tue', label: 'Tuesday', date: '2026-09-29', offeredToVolunteers: true },
  { id: 'wed', label: 'Wednesday', date: '2026-09-30', offeredToVolunteers: true },
];

/** [dayId, "HH:MM-HH:MM", title, needed] */
const TASK_TEMPLATE: [string, string, string, number][] = [
  ['mon', '12:00-15:00', 'Deliveries (RB, Party.rent, ...)', 3],
  ['mon', '13:00-18:00', 'Setup afternoon', 9],
  ['mon', '16:00-17:00', 'Registration setup', 2],

  ['tue', '07:30-10:00', 'Sponsor setup support', 2],
  ['tue', '08:00-13:00', 'Registration morning', 3],
  ['tue', '08:00-13:00', 'Wildcard morning', 1],
  ['tue', '09:00-17:00', 'Room 4 Host', 1],
  ['tue', '09:00-12:30', 'Room 4 Help morning', 1],
  ['tue', '09:00-17:00', 'Room 6 Host', 1],
  ['tue', '09:00-12:30', 'Room 6 Help morning', 1],
  ['tue', '09:00-17:00', 'Videos/Interviews', 1],
  ['tue', '12:00-17:00', 'Wildcard afternoon', 2],
  ['tue', '12:30-17:00', 'Room 4 Help afternoon', 1],
  ['tue', '12:30-17:00', 'Room 6 Help afternoon', 1],
  ['tue', '13:00-17:00', 'Registration afternoon', 2],
  ['tue', '16:30-18:00', 'Hard Rock Cafe sponsor setup', 1],
  ['tue', '17:00-18:00', 'Shuttle-Bus support', 4],

  ['wed', '08:00-13:00', 'Registration morning', 2],
  ['wed', '08:00-13:00', 'Wildcard morning', 2],
  ['wed', '09:00-17:00', 'Room 4 Host', 1],
  ['wed', '09:00-12:30', 'Room 4 Help morning', 1],
  ['wed', '09:00-17:00', 'Room 6 Host', 1],
  ['wed', '09:00-12:30', 'Room 6 Help morning', 1],
  ['wed', '09:00-17:00', 'Videos/Interviews', 1],
  ['wed', '12:00-17:00', 'Wildcard afternoon', 2],
  ['wed', '12:30-17:00', 'Room 4 Help afternoon', 1],
  ['wed', '12:30-17:00', 'Room 6 Help afternoon', 1],
  ['wed', '13:00-17:00', 'Registration afternoon', 2],
  ['wed', '17:00-20:00', 'Event dismantling', 10],
  ['wed', '17:00-18:00', 'Pick-up (RB, Party.rent, ...)', 2],
];

const ORGANIZERS = [
  'Organizer 01',
  'Organizer 02',
  'Organizer 03',
  'Organizer 04',
  'Organizer 05',
  'Organizer 06',
  'Organizer 07',
  'Organizer 08',
];

/** [name, dayIds, wantsMoreThanOneShift] */
const VOLUNTEERS: [string, string[], boolean][] = [
  ['Volunteer 01', ['tue', 'wed'], false],
  ['Volunteer 02', ['tue', 'wed'], true],
  ['Volunteer 03', ['tue', 'wed'], true],
  ['Volunteer 04', ['tue', 'wed'], false],
  ['Volunteer 05', ['tue', 'wed'], true],
  ['Volunteer 06', ['tue'], false],
  ['Volunteer 07', ['wed'], false],
  ['Volunteer 08', ['tue', 'wed'], true],
  ['Volunteer 09', ['tue', 'wed'], true],
  ['Volunteer 10', ['tue', 'wed'], true],
];

export function createFixtureState(): PlanState {
  const tasks: Task[] = TASK_TEMPLATE.map(([dayId, time, title, needed], i) => {
    const range = parseTimeRange(time);
    if (!range) throw new Error(`Bad fixture time "${time}" for "${title}"`);
    return {
      id: `t-fixture-${i}`,
      dayId,
      start: range.start,
      end: range.end,
      title,
      category: inferCategory(title),
      needed,
    };
  });

  const people: Person[] = [
    ...ORGANIZERS.map((name, i) => ({
      id: `p-org-${i}`,
      name,
      isOrganizer: true,
      availableDayIds: DAYS.map((d) => d.id),
      multiShift: true,
      maxShifts: null,
      tags: [],
    })),
    ...VOLUNTEERS.map(([name, dayIds, multi], i) => ({
      id: `p-vol-${i}`,
      name,
      isOrganizer: false,
      availableDayIds: dayIds,
      multiShift: multi,
      maxShifts: null,
      tags: [],
    })),
  ];

  return {
    version: 1,
    eventName: 'Cloud Native Days Austria 2026',
    days: DAYS,
    people,
    tasks,
    assignments: [],
    rules: { ...DEFAULT_RULES },
  };
}
