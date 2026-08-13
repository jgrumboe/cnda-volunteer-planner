import { useMemo } from 'react';
import { CATEGORY_ORDER, CATEGORY_META, type PlanState, type Person } from '../types';
import { computeLoads } from '../lib/plan';
import { newId } from '../lib/importers';

interface Props {
  state: PlanState;
  canEdit: boolean;
  onChange: (people: Person[]) => void;
}

export function PeopleView({ state, canEdit, onChange }: Props) {
  const loads = useMemo(
    () => computeLoads(state.people, state.tasks, state.assignments),
    [state.people, state.tasks, state.assignments],
  );

  const update = (id: string, patch: Partial<Person>) =>
    onChange(state.people.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const remove = (id: string) => onChange(state.people.filter((p) => p.id !== id));

  const add = () =>
    onChange([
      ...state.people,
      {
        id: newId('p'),
        name: '',
        isOrganizer: false,
        availableDayIds: state.days.map((d) => d.id),
        multiShift: true,
        maxShifts: null,
        tags: [],
      },
    ]);

  // Row order is recomputed only when the set of people (or their role) changes —
  // not on every keystroke. Sorting by name on each render made a row jump around
  // mid-word while you were typing into it.
  const orderKey = state.people
    .map((p) => `${p.id}:${p.isOrganizer ? 1 : 0}`)
    .sort()
    .join('|');

  const orderedIds = useMemo(
    () =>
      [...state.people]
        .sort((a, b) => Number(b.isOrganizer) - Number(a.isOrganizer) || a.name.localeCompare(b.name))
        .map((p) => p.id),
    // Intentionally keyed on orderKey rather than state.people: a rename must not reorder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderKey],
  );

  // Map back to live objects so the memoised order never serves stale names.
  const sorted = useMemo(() => {
    const byId = new Map(state.people.map((p) => [p.id, p]));
    const inOrder = orderedIds.map((id) => byId.get(id)).filter((p): p is Person => p !== undefined);
    // Anyone missing from the memoised order (added since) goes at the end.
    const seen = new Set(orderedIds);
    return [...inOrder, ...state.people.filter((p) => !seen.has(p.id))];
  }, [state.people, orderedIds]);

  const organizers = state.people.filter((p) => p.isOrganizer).length;

  return (
    <>
      <div className="panel">
        <div className="stat-row">
          <div className="stat">
            <span className="v">{state.people.length}</span>
            <span className="k">people</span>
          </div>
          <div className="stat">
            <span className="v">{organizers}</span>
            <span className="k">organizers</span>
          </div>
          <div className="stat">
            <span className="v">{state.people.length - organizers}</span>
            <span className="k">volunteers</span>
          </div>
          {state.days.map((d) => (
            <div className="stat" key={d.id}>
              <span
                className={`v ${
                  state.people.filter((p) => p.availableDayIds.includes(d.id)).length < 6 ? 'warn' : ''
                }`}
              >
                {state.people.filter((p) => p.availableDayIds.includes(d.id)).length}
              </span>
              <span className="k">avail {d.label.slice(0, 3)}</span>
            </div>
          ))}
        </div>
      </div>

      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Available</th>
            <th title="Willing to take more than one shift">Multi</th>
            <th title="Hard cap on total shifts">Cap</th>
            <th>Prefers</th>
            <th className="num">Shifts</th>
            <th className="num">Hours</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const load = loads.get(p.id);
            return (
              <tr key={p.id}>
                <td style={{ minWidth: 180 }}>
                  <input
                    type="text"
                    value={p.name}
                    placeholder="Name"
                    onChange={(e) => update(p.id, { name: e.target.value })}
                  />
                </td>
                <td>
                  <button
                    className={`role-tag ${p.isOrganizer ? 'org' : 'vol'}`}
                    style={{ background: 'none', cursor: 'pointer' }}
                    title="Click to switch between organizer and volunteer"
                    onClick={() => update(p.id, { isOrganizer: !p.isOrganizer })}
                  >
                    {p.isOrganizer ? 'Organizer' : 'Volunteer'}
                  </button>
                </td>
                <td>
                  <div className="daytoggles">
                    {state.days.map((d) => {
                      const on = p.availableDayIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          className={`daytoggle ${on ? 'on' : ''}`}
                          onClick={() =>
                            update(p.id, {
                              availableDayIds: on
                                ? p.availableDayIds.filter((x) => x !== d.id)
                                : state.days.filter((x) => x.id === d.id || p.availableDayIds.includes(x.id)).map((x) => x.id),
                            })
                          }
                        >
                          {d.label.slice(0, 3)}
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.multiShift}
                    onChange={(e) => update(p.id, { multiShift: e.target.checked })}
                  />
                </td>
                <td style={{ width: 70 }}>
                  <input
                    type="number"
                    min={1}
                    value={p.maxShifts ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      update(p.id, { maxShifts: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </td>
                <td style={{ minWidth: 140 }}>
                  <select
                    value=""
                    onChange={(e) => {
                      const cat = e.target.value as Person['tags'][number];
                      if (cat && !p.tags.includes(cat)) update(p.id, { tags: [...p.tags, cat] });
                    }}
                  >
                    <option value="">
                      {p.tags.length === 0 ? 'add preference…' : p.tags.map((t) => CATEGORY_META[t].label).join(', ')}
                    </option>
                    {CATEGORY_ORDER.filter((c) => !p.tags.includes(c)).map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_META[c].label}
                      </option>
                    ))}
                  </select>
                  {p.tags.length > 0 ? (
                    <div className="pilllist" style={{ marginTop: 4 }}>
                      {p.tags.map((t) => (
                        <button
                          key={t}
                          className="pill"
                          title="Remove preference"
                          onClick={() => update(p.id, { tags: p.tags.filter((x) => x !== t) })}
                        >
                          {CATEGORY_META[t].label} ✕
                        </button>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td className="num">{load?.shifts ?? 0}</td>
                <td className="num">{(load?.hours ?? 0).toFixed(1)}</td>
                <td>
                  <button className="btn tiny ghost" title="Remove person" onClick={() => remove(p.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <button className="btn" style={{ marginTop: 12 }} onClick={add}>
        + Add person
      </button>
      </fieldset>
    </>
  );
}
