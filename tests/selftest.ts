/**
 * Self-test for the scheduling core. No test framework — bundled with esbuild and run on Node.
 *   npm run selftest
 */

import { proposeAssignments, candidatesForTask } from '../src/lib/assign';
import { computeLoads, findConflicts, totalOpenSlots, withPrunedAssignments } from '../src/lib/plan';
import { createSeedState } from '../src/lib/seed';
import { overlaps, parseTimeRange } from '../src/lib/time';
import { parseCsv } from '../src/lib/xlsx';
import { inferCategory, matchDayIds, mergePeople, newId } from '../src/lib/importers';
import { DAYS } from '../src/lib/seed';
import type { PlanState } from '../src/types';

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = '') {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  ok(actual === expected, label, `expected ${String(expected)}, got ${String(actual)}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- time
section('time parsing');
eq(parseTimeRange('12:00-15:00')?.start, 720, 'start of 12:00-15:00');
eq(parseTimeRange('12:00-15:00')?.end, 900, 'end of 12:00-15:00');
eq(parseTimeRange('07:30-10:00')?.start, 450, '07:30 start');
eq(parseTimeRange('9-17')?.start, 540, 'bare hours');
eq(parseTimeRange('08:00 – 13:00')?.end, 780, 'en dash separator');
eq(parseTimeRange('17:00-09:00'), null, 'rejects end before start');
eq(parseTimeRange('garbage'), null, 'rejects garbage');
ok(
  !overlaps({ start: 750, end: 1020 }, { start: 1020, end: 1080 }),
  'touching ranges do not overlap (12:30-17:00 vs 17:00-18:00)',
);
ok(overlaps({ start: 540, end: 1020 }, { start: 750, end: 1020 }), 'contained range overlaps');

// ---------------------------------------------------------------- importers
section('importers');
eq(inferCategory('Registration setup'), 'setup', '"Registration setup" is setup, not registration');
eq(inferCategory('Room 4 Help morning'), 'roomHelp', 'room help');
eq(inferCategory('Room 6 Host'), 'roomHost', 'room host');
eq(inferCategory('Event dismantling'), 'teardown', 'teardown');
eq(inferCategory('Pick-up (RB, Party.rent, ...)'), 'logistics', 'pick-up is logistics');
eq(inferCategory('Shuttle-Bus support'), 'logistics', 'shuttle is logistics');
eq(inferCategory('Videos/Interviews'), 'media', 'media');
eq(inferCategory('Wildcard morning'), 'wildcard', 'wildcard');

const formAnswer = 'Tuesday, 29th September, Wednesday, 30th September';
eq(matchDayIds(formAnswer, DAYS).join('+'), 'tue+wed', 'comma-in-value day answer parsed');
eq(matchDayIds('Wednesday, 30th September', DAYS).join('+'), 'wed', 'single day parsed');
eq(matchDayIds('Monday 28th September (Afternoon, venue setup)', DAYS).join('+'), 'mon', 'monday parsed');
eq(matchDayIds('', DAYS).length, 0, 'empty answer yields no days');

eq(parseCsv('a,b\n1,"x,y"\n').length, 2, 'csv row count');
eq(parseCsv('a,b\n1,"x,y"')[1][1], 'x,y', 'csv quoted comma');
eq(parseCsv('a\n"he said ""hi"""')[1][0], 'he said "hi"', 'csv escaped quotes');

const merged = mergePeople(
  [{ id: 'a', name: 'Volunteer 04', isOrganizer: false, availableDayIds: ['tue'], multiShift: false, maxShifts: null, tags: [] }],
  [{ id: 'b', name: 'mario  schober', isOrganizer: false, availableDayIds: ['wed'], multiShift: false, maxShifts: null, tags: [] }],
);
eq(merged.added, 0, 'fuzzy name match does not duplicate');
eq(merged.updated, 1, 'existing person updated');
eq(merged.people[0].availableDayIds.join('+'), 'tue+wed', 'availability unioned');

// ---------------------------------------------------------------- ids
section('id generation');
{
  const ids = new Set<string>();
  for (let i = 0; i < 20_000; i++) ids.add(newId('p'));
  eq(ids.size, 20_000, '20k ids minted in a tight loop are all distinct');
  ok(/^p-/.test(newId('p')), 'prefix preserved');
  // The old implementation was Date.now() + a per-page counter, so two clients
  // could collide within a millisecond. Guard against a regression to a time-based id.
  const a = newId('t');
  const b = newId('t');
  ok(a !== b, 'consecutive ids differ');
  ok(
    !new RegExp(`^t-${Date.now().toString(36).slice(0, 6)}`).test(a),
    'id is not derived from the current clock',
  );
}

// ------------------------------------------------------- cascade on delete
section('cascade on delete');
{
  const base = createSeedState();
  const person = base.people[0];
  const task = base.tasks.find((t) => t.dayId === 'mon')!;
  const other = base.tasks.find((t) => t.dayId === 'wed' && t.needed > 2)!;
  const withAssignments: PlanState = {
    ...base,
    assignments: [
      { taskId: task.id, personId: person.id, pinned: true, source: 'manual' },
      { taskId: other.id, personId: base.people[1].id, pinned: true, source: 'manual' },
    ],
  };

  // Nothing to prune -> same array reference, so downstream memos stay valid.
  const untouched = withPrunedAssignments(withAssignments);
  ok(
    untouched.assignments === withAssignments.assignments,
    'returns the identical assignments array when nothing cascades',
  );

  // Deleting a person drops only their assignments.
  const personGone = withPrunedAssignments({
    ...withAssignments,
    people: withAssignments.people.filter((p) => p.id !== person.id),
  });
  eq(personGone.assignments.length, 1, 'deleting a person cascades to their assignment');
  ok(
    personGone.assignments.every((a) => a.personId !== person.id),
    'no assignment survives referencing the deleted person',
  );

  // The bug this guards: a ghost assignment still counted toward coverage, so the
  // task looked staffed by somebody no longer in the plan.
  const naive: PlanState = {
    ...withAssignments,
    people: withAssignments.people.filter((p) => p.id !== person.id),
  };
  ok(
    totalOpenSlots(naive) < totalOpenSlots(personGone),
    'without the cascade the plan under-reports open slots',
  );
  eq(findConflicts(personGone).length, 0, 'pruned plan reports no orphan conflicts');
  ok(
    findConflicts(naive).some((c) => /Orphaned/i.test(c.message)),
    'un-pruned plan does report an orphan',
  );

  // Deleting a task cascades too.
  const taskGone = withPrunedAssignments({
    ...withAssignments,
    tasks: withAssignments.tasks.filter((t) => t.id !== task.id),
  });
  eq(taskGone.assignments.length, 1, 'deleting a task cascades to its assignments');
}

// ---------------------------------------------------------------- seed
section('seed data');
const seed = createSeedState();
eq(seed.tasks.length, 30, 'task count');
eq(seed.people.length, 18, 'people count (8 organizers + 10 volunteers)');
eq(seed.people.filter((p) => p.isOrganizer).length, 8, 'organizer count');
eq(totalOpenSlots(seed), 63, 'total open slots');
eq(findConflicts(seed).length, 0, 'seed plan has no conflicts');

// ---------------------------------------------------------------- allocator
section('allocator');
const proposal = proposeAssignments(seed, 12345);
const withProposal: PlanState = { ...seed, assignments: [...seed.assignments, ...proposal.additions] };
const conflicts = findConflicts(withProposal);

ok(proposal.additions.length > 0, 'produces assignments');
ok(conflicts.length === 0, 'proposal violates no hard constraint', conflicts.map((c) => c.message).join(' | '));
eq(proposal.openSlotsBefore, 63, 'reports open slots before');

// Never over-fill a task.
const perTask = new Map<string, number>();
for (const a of withProposal.assignments) perTask.set(a.taskId, (perTask.get(a.taskId) ?? 0) + 1);
ok(
  seed.tasks.every((t) => (perTask.get(t.id) ?? 0) <= t.needed),
  'never exceeds needed head count',
);

// Single-shift volunteers get at most one shift.
const loads = computeLoads(withProposal.people, withProposal.tasks, withProposal.assignments);
const singleShiftBreaches = withProposal.people
  .filter((p) => !p.multiShift && (loads.get(p.id)?.shifts ?? 0) > 1)
  .map((p) => p.name);
eq(singleShiftBreaches.length, 0, `single-shift preference honoured (${singleShiftBreaches.join(', ')})`);

// Availability respected.
const taskById = new Map(seed.tasks.map((t) => [t.id, t]));
const availBreaches = withProposal.assignments.filter((a) => {
  const t = taskById.get(a.taskId)!;
  const p = withProposal.people.find((x) => x.id === a.personId)!;
  return !p.availableDayIds.includes(t.dayId);
});
eq(availBreaches.length, 0, 'nobody scheduled on an unavailable day');

// Non-organizers keep to one regular shift per day.
const dayLimitBreaches: string[] = [];
for (const p of withProposal.people.filter((x) => !x.isOrganizer)) {
  const load = loads.get(p.id)!;
  for (const [dayId, n] of Object.entries(load.regularPerDay)) {
    if (n > 1) dayLimitBreaches.push(`${p.name}/${dayId}=${n}`);
  }
}
eq(dayLimitBreaches.length, 0, `one regular shift per day for volunteers (${dayLimitBreaches.join(', ')})`);

// Determinism and reshuffling.
const again = proposeAssignments(seed, 12345);
eq(again.additions.length, proposal.additions.length, 'same seed gives same fill count');
eq(
  JSON.stringify(again.additions),
  JSON.stringify(proposal.additions),
  'same seed gives identical assignments',
);
const other = proposeAssignments(seed, 999);
ok(
  JSON.stringify(other.additions) !== JSON.stringify(proposal.additions),
  'a different seed explores a different solution',
);

// Pinned work is never touched or duplicated.
const pinnedPerson = seed.people.find((p) => p.name === 'Volunteer 04')!;
const pinnedTask = seed.tasks.find((t) => t.dayId === 'tue' && t.title === 'Room 4 Help morning')!;
const withPinned: PlanState = {
  ...seed,
  assignments: [{ taskId: pinnedTask.id, personId: pinnedPerson.id, pinned: true, source: 'manual' }],
};
const p2 = proposeAssignments(withPinned, 42);
ok(
  !p2.additions.some((a) => a.taskId === pinnedTask.id && a.personId === pinnedPerson.id),
  'does not duplicate a pinned assignment',
);
ok(
  p2.additions.every((a) => !(a.personId === pinnedPerson.id && taskById.get(a.taskId)?.dayId === 'tue')),
  'respects the day limit set up by a pinned assignment',
);
eq(p2.openSlotsBefore, 62, 'open slot count accounts for the pinned assignment');

// Balance: nobody should be wildly over-worked relative to the rest.
const volunteerShifts = withProposal.people
  .filter((p) => !p.isOrganizer && p.multiShift)
  .map((p) => loads.get(p.id)?.shifts ?? 0);
const spread = Math.max(...volunteerShifts) - Math.min(...volunteerShifts);
ok(spread <= 2, 'multi-shift volunteer workload is balanced', `spread of ${spread} shifts`);

// Room-help slots prefer volunteers over organizers.
const roomHelpTaskIds = new Set(seed.tasks.filter((t) => t.category === 'roomHelp').map((t) => t.id));
const orgIds = new Set(seed.people.filter((p) => p.isOrganizer).map((p) => p.id));
const roomHelpAssignments = withProposal.assignments.filter((a) => roomHelpTaskIds.has(a.taskId));
const orgInRoomHelp = roomHelpAssignments.filter((a) => orgIds.has(a.personId)).length;
ok(
  roomHelpAssignments.length > 0,
  'room-help slots got filled',
);
console.log(
  `  info  room-help slots filled ${roomHelpAssignments.length}/${roomHelpTaskIds.size}, of which organizers: ${orgInRoomHelp}`,
);

// ---------------------------------------------------------------- candidates
section('candidate explanations');
const monTask = seed.tasks.find((t) => t.dayId === 'mon')!;
const cands = candidatesForTask(seed, monTask.id);
eq(cands.length, 18, 'every person is listed');
const volunteerOnMonday = cands.find((c) => c.person.name === 'Volunteer 04');
eq(volunteerOnMonday?.reject, 'dayUnavailable', 'Monday-unavailable volunteer is rejected with a reason');
ok(
  cands.filter((c) => c.reject === null).length === 8,
  'only the 8 organizers can work Monday',
  `${cands.filter((c) => c.reject === null).length} eligible`,
);

// ---------------------------------------------------------------- summary
console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed.`,
);
console.log(
  `Filled ${proposal.additions.length}/${proposal.openSlotsBefore} open slots; ` +
    `${proposal.unfilled.reduce((s, u) => s + u.count, 0)} slots could not be filled.`,
);
if (proposal.unfilled.length > 0) {
  console.log('Unfillable:');
  for (const u of proposal.unfilled) {
    const t = taskById.get(u.taskId);
    console.log(`  ${t?.title} (${t?.dayId}) x${u.count} — ${u.reasons.join(', ') || 'nobody eligible'}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
