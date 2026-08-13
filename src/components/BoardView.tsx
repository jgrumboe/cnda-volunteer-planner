import { useMemo, useState } from 'react';
import { CATEGORY_META, type PlanState, type Task } from '../types';
import { assigneesOf, computeLoads, type Conflict } from '../lib/plan';
import { candidatesForTask, REJECT_LABEL } from '../lib/assign';
import { fmtClock } from '../lib/time';
import { Modal } from './Modal';

interface Props {
  state: PlanState;
  conflictsByPerson: Map<string, Conflict[]>;
  understaffedTaskIds: Set<string>;
  onAssign: (taskId: string, personId: string) => void;
  onUnassign: (taskId: string, personId: string) => void;
  onTogglePin: (taskId: string, personId: string) => void;
}

export function BoardView({
  state,
  conflictsByPerson,
  understaffedTaskIds,
  onAssign,
  onUnassign,
  onTogglePin,
}: Props) {
  const [picker, setPicker] = useState<Task | null>(null);
  const peopleById = useMemo(() => new Map(state.people.map((p) => [p.id, p])), [state.people]);

  const byDay = state.days.map((day) => ({
    day,
    tasks: state.tasks
      .filter((t) => t.dayId === day.id)
      .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title)),
  }));

  return (
    <>
      <div className="board">
        {byDay.map(({ day, tasks }) => {
          const missing = tasks.reduce(
            (sum, t) => sum + Math.max(0, t.needed - assigneesOf(state.assignments, t.id).length),
            0,
          );
          return (
            <div className="day-col" key={day.id}>
              <div className="day-head">
                <h2>{day.label}</h2>
                <span className="date">{day.date}</span>
                <span className={`warn-chip ${missing === 0 ? 'ok' : missing > 3 ? 'bad' : ''}`}>
                  {missing === 0 ? 'fully staffed' : `${missing} open`}
                </span>
              </div>

              {tasks.map((task) => {
                const assigned = assigneesOf(state.assignments, task.id);
                const missingHere = Math.max(0, task.needed - assigned.length);
                const over = assigned.length > task.needed;
                const fillClass = over
                  ? 'empty'
                  : missingHere === 0
                    ? 'full'
                    : assigned.length === 0
                      ? 'empty'
                      : 'partial';
                const meta = CATEGORY_META[task.category];

                return (
                  <div className={`task-card ${fillClass}`} key={task.id}>
                    <div className="task-top">
                      <span className="task-time">
                        {fmtClock(task.start)}–{fmtClock(task.end)}
                      </span>
                      <span className="task-title">{task.title}</span>
                      <span
                        className={`count ${
                          over ? 'none' : missingHere === 0 ? 'ok' : assigned.length === 0 ? 'none' : 'short'
                        }`}
                      >
                        {assigned.length}/{task.needed}
                      </span>
                    </div>

                    <div style={{ marginTop: 5, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className={`chip ${meta.allHands ? 'allhands' : ''}`}>{meta.label}</span>
                      {over ? (
                        <span className="warn-chip bad">{assigned.length - task.needed} too many</span>
                      ) : null}
                      {understaffedTaskIds.has(task.id) && assigned.length === 0 ? (
                        <span className="warn-chip bad">nobody assigned</span>
                      ) : null}
                    </div>

                    <ul className="assignees">
                      {assigned
                        .slice()
                        .sort((a, b) =>
                          (peopleById.get(a.personId)?.name ?? '').localeCompare(
                            peopleById.get(b.personId)?.name ?? '',
                          ),
                        )
                        .map((a) => {
                          const person = peopleById.get(a.personId);
                          const personProblems = conflictsByPerson.get(a.personId) ?? [];
                          // Only surface problems that concern this task, or that are
                          // about the person's overall load.
                          const relevant = personProblems.filter(
                            (c) => c.taskId === undefined || c.taskId === task.id,
                          );
                          return (
                            <li
                              key={a.personId}
                              className={`assignee ${person?.isOrganizer ? 'organizer' : ''} ${
                                a.source === 'suggested' ? 'suggested' : ''
                              }`}
                              style={
                                relevant.length > 0
                                  ? { borderLeft: '3px solid var(--bad)', paddingLeft: 4 }
                                  : undefined
                              }
                            >
                              <button
                                className={`pin ${a.pinned ? 'on' : ''}`}
                                title={
                                  a.pinned
                                    ? 'Pinned — the allocator will not move this'
                                    : 'Suggested — a reshuffle may replace it'
                                }
                                onClick={() => onTogglePin(task.id, a.personId)}
                              >
                                {a.pinned ? '📌' : '○'}
                              </button>
                              <span className="name">{person?.name ?? 'unknown'}</span>
                              {relevant.length > 0 ? (
                                <span
                                  title={relevant.map((c) => c.message).join('\n')}
                                  style={{ color: 'var(--bad)', cursor: 'help', fontSize: 12 }}
                                >
                                  ⚠
                                </span>
                              ) : null}
                              <button
                                className="remove"
                                title="Remove from task"
                                onClick={() => onUnassign(task.id, a.personId)}
                              >
                                ✕
                              </button>
                            </li>
                          );
                        })}

                      {Array.from({ length: missingHere }).map((_, i) => (
                        <li key={`gap-${i}`} className="slot-empty">
                          open slot
                        </li>
                      ))}
                    </ul>

                    <button className="btn tiny ghost" style={{ marginTop: 6 }} onClick={() => setPicker(task)}>
                      + assign someone
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {picker ? (
        <CandidatePicker
          state={state}
          task={picker}
          onClose={() => setPicker(null)}
          onPick={(personId) => {
            onAssign(picker.id, personId);
            setPicker(null);
          }}
        />
      ) : null}
    </>
  );
}

function CandidatePicker({
  state,
  task,
  onPick,
  onClose,
}: {
  state: PlanState;
  task: Task;
  onPick: (personId: string) => void;
  onClose: () => void;
}) {
  const candidates = useMemo(() => candidatesForTask(state, task.id), [state, task.id]);
  const loads = useMemo(
    () => computeLoads(state.people, state.tasks, state.assignments),
    [state.people, state.tasks, state.assignments],
  );
  const day = state.days.find((d) => d.id === task.dayId);
  const assignedNow = state.assignments.filter((a) => a.taskId === task.id).length;

  const fits = candidates.filter((c) => c.reject === null);
  // "alreadyOnTask" is the one case where overriding makes no sense.
  const breaksRule = candidates.filter((c) => c.reject !== null && c.reject !== 'alreadyOnTask');

  const row = (
    { person, reject }: (typeof candidates)[number],
    override: boolean,
  ) => {
    const load = loads.get(person.id);
    return (
      <li key={person.id}>
        <button
          className="candidate"
          onClick={() => onPick(person.id)}
          title={override ? 'Assign anyway — the plan will flag this as a warning' : undefined}
        >
          <span className={`role-tag ${person.isOrganizer ? 'org' : 'vol'}`}>
            {person.isOrganizer ? 'ORG' : 'VOL'}
          </span>
          <span style={{ flex: 1 }}>
            {person.name}
            {reject ? (
              <span className="why" style={{ color: 'var(--warn)' }}> — {REJECT_LABEL[reject]}</span>
            ) : null}
          </span>
          <span className="load">
            {load?.shifts ?? 0} shifts · {(load?.hours ?? 0).toFixed(1)}h
          </span>
        </button>
      </li>
    );
  };

  return (
    <Modal
      title={`${task.title} — ${day?.label ?? ''} ${fmtClock(task.start)}–${fmtClock(task.end)}`}
      onClose={onClose}
    >
      <p className="hint">
        {assignedNow}/{task.needed} filled. {fits.length} people fit without breaking a rule.
        {assignedNow >= task.needed
          ? ' This task is already full — assigning more will be flagged as overstaffed.'
          : ''}
      </p>

      {fits.length > 0 ? (
        <>
          <h4 className="prop-group" style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--faint)' }}>
            BEST FIT FIRST
          </h4>
          <ul className="candidate-list">{fits.map((c) => row(c, false))}</ul>
        </>
      ) : (
        <p className="hint" style={{ color: 'var(--warn)' }}>
          Nobody can take this slot without breaking a rule. You can still assign someone below — it will
          show up as a warning rather than being silently accepted.
        </p>
      )}

      {breaksRule.length > 0 ? (
        <>
          <h4
            style={{
              margin: '16px 0 4px',
              fontSize: 12,
              color: 'var(--faint)',
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            Would break a rule — assign anyway
          </h4>
          <ul className="candidate-list">{breaksRule.map((c) => row(c, true))}</ul>
        </>
      ) : null}
    </Modal>
  );
}
