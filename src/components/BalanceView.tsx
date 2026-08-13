import { useMemo } from 'react';
import type { PlanState } from '../types';
import { computeLoads, coverage, findConflicts, tasksOfPerson } from '../lib/plan';
import { fmtClock } from '../lib/time';

export function BalanceView({ state }: { state: PlanState }) {
  const loads = useMemo(
    () => computeLoads(state.people, state.tasks, state.assignments),
    [state.people, state.tasks, state.assignments],
  );
  const conflicts = useMemo(() => findConflicts(state), [state]);
  const rows = coverage(state);

  const workers = state.people.filter((p) => p.availableDayIds.length > 0);
  const shiftCounts = workers.map((p) => loads.get(p.id)?.shifts ?? 0);
  const maxShifts = Math.max(1, ...shiftCounts);
  const spread = shiftCounts.length ? Math.max(...shiftCounts) - Math.min(...shiftCounts) : 0;
  const unstaffed = rows.filter((r) => r.missing > 0);
  const totalMissing = unstaffed.reduce((s, r) => s + r.missing, 0);

  const sorted = [...state.people].sort(
    (a, b) => (loads.get(b.id)?.shifts ?? 0) - (loads.get(a.id)?.shifts ?? 0) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <div className="panel">
        <h3>Overview</h3>
        <div className="stat-row">
          <div className="stat">
            <span className={`v ${totalMissing === 0 ? 'ok' : 'bad'}`}>{totalMissing}</span>
            <span className="k">open slots</span>
          </div>
          <div className="stat">
            <span className={`v ${conflicts.length === 0 ? 'ok' : 'bad'}`}>{conflicts.length}</span>
            <span className="k">rule breaches</span>
          </div>
          <div className="stat">
            <span className={`v ${spread <= 2 ? 'ok' : 'warn'}`}>{spread}</span>
            <span className="k">shift spread</span>
          </div>
          <div className="stat">
            <span className="v">{state.assignments.length}</span>
            <span className="k">assignments</span>
          </div>
          <div className="stat">
            <span className="v">{state.assignments.filter((a) => a.pinned).length}</span>
            <span className="k">pinned</span>
          </div>
        </div>
      </div>

      {conflicts.length > 0 ? (
        <div className="panel">
          <h3>Rule breaches</h3>
          <ul className="issues">
            {conflicts.map((c, i) => (
              <li key={i} className={c.kind === 'overCapacity' ? 'warn' : ''}>
                {c.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unstaffed.length > 0 ? (
        <div className="panel">
          <h3>Understaffed tasks</h3>
          <ul className="issues">
            {unstaffed.map(({ task, assigned, missing }) => {
              const day = state.days.find((d) => d.id === task.dayId);
              return (
                <li key={task.id} className="warn">
                  {day?.label} {fmtClock(task.start)}–{fmtClock(task.end)} · {task.title} — {assigned}/
                  {task.needed}, missing {missing}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="panel">
        <h3>Workload per person</h3>
        <div className="bars">
          {sorted.map((p) => {
            const load = loads.get(p.id);
            const shifts = load?.shifts ?? 0;
            return (
              <div className="bar-row" key={p.id}>
                <span style={{ color: p.isOrganizer ? 'var(--org)' : undefined }}>
                  {p.name || <em style={{ color: 'var(--faint)' }}>unnamed</em>}
                  {p.availableDayIds.length === 0 ? (
                    <span className="why" style={{ color: 'var(--faint)' }}> (no availability)</span>
                  ) : null}
                </span>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${p.isOrganizer ? 'org' : ''}`}
                    style={{ width: `${(shifts / maxShifts) * 100}%` }}
                  />
                </div>
                <span className="bar-meta">
                  {shifts} · {(load?.hours ?? 0).toFixed(1)}h
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <h3>Per-person schedule</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              {state.days.map((d) => (
                <th key={d.id}>
                  {d.label} <span style={{ color: 'var(--faint)' }}>{d.date}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const mine = tasksOfPerson(state.tasks, state.assignments, p.id);
              return (
                <tr key={p.id}>
                  <td style={{ color: p.isOrganizer ? 'var(--org)' : undefined, whiteSpace: 'nowrap' }}>
                    {p.name}
                  </td>
                  {state.days.map((d) => (
                    <td key={d.id} style={{ fontSize: 12 }}>
                      {mine
                        .filter((t) => t.dayId === d.id)
                        .sort((a, b) => a.start - b.start)
                        .map((t) => (
                          <div key={t.id}>
                            <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                              {fmtClock(t.start)}–{fmtClock(t.end)}
                            </span>{' '}
                            {t.title}
                          </div>
                        ))}
                      {mine.filter((t) => t.dayId === d.id).length === 0 &&
                      p.availableDayIds.includes(d.id) ? (
                        <span style={{ color: 'var(--faint)' }}>free</span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
