/**
 * Personal "My shifts" view — shows the signed-in person's schedule.
 *
 * - On now / Up next via NowView with personId filter
 * - Full personal schedule grouped by day
 * - Who else is on the same shift
 * - If personId is unlinked, prompts to ask an organizer
 */

import { useMemo } from 'react';
import type { PlanState } from '../types';
import { NowView } from './NowView';
import { fmtRange } from '../lib/time';
import { coworkers } from '../lib/clock';

interface Props {
  state: PlanState;
  personId: string | null;
}

export function MyShiftsView({ state, personId }: Props) {
  if (!personId) {
    return (
      <div className="now-view">
        <div className="now-phase-message">
          <h2>Your account isn't linked to a person yet</h2>
          <p>Ask an organizer to link your login to your name in the People tab.</p>
        </div>
      </div>
    );
  }

  const person = state.people.find((p) => p.id === personId);
  if (!person) {
    return (
      <div className="now-view">
        <div className="now-phase-message">
          <h2>Person not found</h2>
          <p>Your linked person ID doesn't match anyone in the plan. Ask an organizer to fix this.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="now-view">
      <h2 style={{ margin: '0 0 16px' }}>Hi, {person.name.split(' ')[0]}</h2>

      {/* Live now/next with personal filter */}
      <NowView state={state} personId={personId} />

      {/* Full schedule */}
      <FullSchedule state={state} personId={personId} />
    </div>
  );
}

function FullSchedule({ state, personId }: { state: PlanState; personId: string }) {
  const myTasks = useMemo(() => {
    const assigned = new Set(
      state.assignments.filter((a) => a.personId === personId).map((a) => a.taskId),
    );
    return state.tasks.filter((t) => assigned.has(t.id));
  }, [state.assignments, state.tasks, personId]);

  const byDay = useMemo(() => {
    const map = new Map<string, typeof myTasks>();
    for (const task of myTasks) {
      const list = map.get(task.dayId) ?? [];
      list.push(task);
      map.set(task.dayId, list);
    }
    // Sort tasks within each day
    for (const list of map.values()) {
      list.sort((a, b) => a.start - b.start);
    }
    return map;
  }, [myTasks]);

  if (myTasks.length === 0) {
    return (
      <div className="now-section" style={{ marginTop: 24 }}>
        <h3>Your schedule</h3>
        <p style={{ color: 'var(--muted)' }}>No shifts assigned yet.</p>
      </div>
    );
  }

  return (
    <div className="now-section" style={{ marginTop: 24 }}>
      <h3>Your full schedule</h3>
      {state.days
        .filter((d) => byDay.has(d.id))
        .map((day) => (
          <div key={day.id} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
              {day.label} · {day.date}
            </div>
            <div className="now-cards">
              {byDay.get(day.id)!.map((task) => {
                const others = coworkers(state, task.id).filter((c) => c.personId !== personId);
                return (
                  <div key={task.id} className="now-card now-card-later">
                    <div className="now-card-header">
                      <span className="now-card-title">{task.title}</span>
                      <span className="now-card-time">{fmtRange(task)}</span>
                    </div>
                    {others.length > 0 ? (
                      <div className="now-card-people">
                        {others.map((p) => (
                          <span key={p.personId} className="now-card-person">{p.name}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
    </div>
  );
}
