import { CATEGORY_META, CATEGORY_ORDER, type PlanState, type Task, type TaskCategory } from '../types';
import { assigneesOf } from '../lib/plan';
import { fmtClock, parseTimeRange } from '../lib/time';
import { newId } from '../lib/importers';

interface Props {
  state: PlanState;
  canEdit: boolean;
  onChange: (tasks: Task[]) => void;
}

export function TasksView({ state, canEdit, onChange }: Props) {
  const update = (id: string, patch: Partial<Task>) =>
    onChange(state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const remove = (id: string) => onChange(state.tasks.filter((t) => t.id !== id));

  const add = () =>
    onChange([
      ...state.tasks,
      {
        id: newId('t'),
        dayId: state.days[0]?.id ?? '',
        start: 9 * 60,
        end: 12 * 60,
        title: '',
        category: 'other',
        needed: 1,
      },
    ]);

  const dayOrder = new Map(state.days.map((d, i) => [d.id, i]));
  const sorted = [...state.tasks].sort(
    (a, b) => (dayOrder.get(a.dayId) ?? 0) - (dayOrder.get(b.dayId) ?? 0) || a.start - b.start,
  );

  const totalNeeded = state.tasks.reduce((s, t) => s + t.needed, 0);
  const totalAssigned = state.assignments.length;

  return (
    <>
      <div className="panel">
        <div className="stat-row">
          <div className="stat">
            <span className="v">{state.tasks.length}</span>
            <span className="k">tasks</span>
          </div>
          <div className="stat">
            <span className="v">{totalNeeded}</span>
            <span className="k">slots needed</span>
          </div>
          <div className="stat">
            <span className={`v ${totalAssigned < totalNeeded ? 'warn' : 'ok'}`}>{totalAssigned}</span>
            <span className="k">slots filled</span>
          </div>
          <div className="stat">
            <span className={`v ${totalNeeded - totalAssigned > 0 ? 'bad' : 'ok'}`}>
              {Math.max(0, totalNeeded - totalAssigned)}
            </span>
            <span className="k">still open</span>
          </div>
        </div>
      </div>

      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
      <table className="grid">
        <thead>
          <tr>
            <th>Day</th>
            <th>Time</th>
            <th>Task</th>
            <th>Category</th>
            <th className="num">Needed</th>
            <th className="num">Assigned</th>
            <th>Coverage</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const assigned = assigneesOf(state.assignments, t.id).length;
            const pct = t.needed === 0 ? 100 : Math.min(100, (assigned / t.needed) * 100);
            return (
              <tr key={t.id}>
                <td style={{ width: 110 }}>
                  <select value={t.dayId} onChange={(e) => update(t.id, { dayId: e.target.value })}>
                    {state.days.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ width: 120 }}>
                  <input
                    // defaultValue only applies at mount, and the row key is the task id,
                    // so without this the field would never reflect a start/end changed
                    // elsewhere (import, backup restore). Keying on the parsed range
                    // remounts the input whenever the actual time changes.
                    key={`${t.start}-${t.end}`}
                    type="text"
                    defaultValue={`${fmtClock(t.start)}-${fmtClock(t.end)}`}
                    onBlur={(e) => {
                      const r = parseTimeRange(e.target.value);
                      if (r) update(t.id, { start: r.start, end: r.end });
                      else e.target.value = `${fmtClock(t.start)}-${fmtClock(t.end)}`;
                    }}
                  />
                </td>
                <td style={{ minWidth: 220 }}>
                  <input
                    type="text"
                    value={t.title}
                    placeholder="Task name"
                    onChange={(e) => update(t.id, { title: e.target.value })}
                  />
                </td>
                <td style={{ width: 150 }}>
                  <select
                    value={t.category}
                    onChange={(e) => update(t.id, { category: e.target.value as TaskCategory })}
                  >
                    {CATEGORY_ORDER.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_META[c].label}
                        {CATEGORY_META[c].allHands ? ' (all-hands)' : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num" style={{ width: 80 }}>
                  <input
                    type="number"
                    min={1}
                    value={t.needed}
                    onChange={(e) => update(t.id, { needed: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </td>
                <td className="num">{assigned}</td>
                <td style={{ width: 120 }}>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${pct}%`,
                        background: pct === 100 ? 'var(--ok)' : pct === 0 ? 'var(--bad)' : 'var(--warn)',
                      }}
                    />
                  </div>
                </td>
                <td>
                  <button className="btn tiny ghost" title="Delete task" onClick={() => remove(t.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <button className="btn" style={{ marginTop: 12 }} onClick={add}>
        + Add task
      </button>
      </fieldset>
    </>
  );
}
