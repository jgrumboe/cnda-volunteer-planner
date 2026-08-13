/** Domain model for the CND Austria volunteer planner. */

export interface EventDay {
  id: string;
  label: string;
  /** ISO date, e.g. "2026-09-29". */
  date: string;
  /** Whether the registration form offers this day to volunteers. */
  offeredToVolunteers: boolean;
}

export type TaskCategory =
  | 'setup'
  | 'teardown'
  | 'logistics'
  | 'registration'
  | 'roomHost'
  | 'roomHelp'
  | 'wildcard'
  | 'media'
  | 'other';

export interface CategoryMeta {
  label: string;
  /** Bulk tasks that may stack on top of a regular shift when times don't overlap. */
  allHands: boolean;
  /** Fill with volunteers before organizers. */
  preferNonOrganizer: boolean;
  /** A person should hold this category at most once across the whole event. */
  oncePerPerson: boolean;
}

export const CATEGORY_META: Record<TaskCategory, CategoryMeta> = {
  setup: { label: 'Setup', allHands: true, preferNonOrganizer: false, oncePerPerson: false },
  teardown: { label: 'Teardown', allHands: true, preferNonOrganizer: false, oncePerPerson: false },
  logistics: { label: 'Logistics', allHands: true, preferNonOrganizer: false, oncePerPerson: false },
  registration: { label: 'Registration', allHands: false, preferNonOrganizer: true, oncePerPerson: false },
  roomHost: { label: 'Room Host', allHands: false, preferNonOrganizer: false, oncePerPerson: false },
  roomHelp: { label: 'Room Help', allHands: false, preferNonOrganizer: true, oncePerPerson: true },
  wildcard: { label: 'Wildcard', allHands: false, preferNonOrganizer: true, oncePerPerson: false },
  media: { label: 'Media', allHands: false, preferNonOrganizer: false, oncePerPerson: false },
  other: { label: 'Other', allHands: false, preferNonOrganizer: false, oncePerPerson: false },
};

export const CATEGORY_ORDER: TaskCategory[] = [
  'logistics', 'setup', 'registration', 'roomHost', 'roomHelp', 'wildcard', 'media', 'teardown', 'other',
];

export interface Task {
  id: string;
  dayId: string;
  /** Minutes from midnight. */
  start: number;
  end: number;
  title: string;
  category: TaskCategory;
  /** Head count required. */
  needed: number;
  notes?: string;
}

export interface Person {
  id: string;
  name: string;
  isOrganizer: boolean;
  availableDayIds: string[];
  /** Willing to take more than one shift. */
  multiShift: boolean;
  /** Hard cap on total shifts; null = no explicit cap. */
  maxShifts: number | null;
  /** Preferred task categories, used as a scoring bonus. */
  tags: TaskCategory[];
  notes?: string;
}

export type AssignmentSource = 'manual' | 'suggested' | 'imported';

export interface Assignment {
  taskId: string;
  personId: string;
  /** Pinned assignments are never moved or removed by the allocator. */
  pinned: boolean;
  source: AssignmentSource;
}

export interface Rules {
  /** Normally at most one regular shift per person per day. */
  oneShiftPerDay: boolean;
  /** All-hands categories don't count toward the per-day limit. */
  allHandsExempt: boolean;
  /** Organizers may stack multiple regular shifts per day. */
  organizersExemptFromDayLimit: boolean;
  /** Honour the "more than one shift" answer from the form. */
  respectMultiShift: boolean;
  preferNonOrganizerForHelpRoles: boolean;
  enforceOncePerCategory: boolean;
  balanceBy: 'countThenHours' | 'hours' | 'count';
  /** Randomized-greedy runs per suggestion; higher = better packing, slower. */
  iterations: number;
}

export const DEFAULT_RULES: Rules = {
  oneShiftPerDay: true,
  allHandsExempt: true,
  organizersExemptFromDayLimit: true,
  respectMultiShift: true,
  preferNonOrganizerForHelpRoles: true,
  enforceOncePerCategory: true,
  balanceBy: 'countThenHours',
  iterations: 400,
};

export interface PlanState {
  version: number;
  eventName: string;
  days: EventDay[];
  people: Person[];
  tasks: Task[];
  assignments: Assignment[];
  rules: Rules;
}
