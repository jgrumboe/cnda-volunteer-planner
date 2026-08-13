import type { Rules } from '../types';
import { Modal } from './Modal';

const TOGGLES: { key: keyof Rules; label: string; help: string }[] = [
  {
    key: 'oneShiftPerDay',
    label: 'At most one regular shift per person per day',
    help: 'The baseline fairness rule. All-hands tasks can sit on top of it — see below.',
  },
  {
    key: 'allHandsExempt',
    label: 'All-hands tasks do not count toward the daily limit',
    help: 'Setup, Teardown and Logistics may stack on a regular shift as long as the times do not overlap. This matches how your spreadsheet actually worked.',
  },
  {
    key: 'organizersExemptFromDayLimit',
    label: 'Organizers may take several shifts per day',
    help: 'Organizers are on site all day anyway, so the daily limit only applies to volunteers.',
  },
  {
    key: 'respectMultiShift',
    label: 'Honour the "more than one shift" answer',
    help: 'Anyone who answered No in the registration form gets exactly one shift for the whole event.',
  },
  {
    key: 'preferNonOrganizerForHelpRoles',
    label: 'Fill Registration, Room Help and Wildcard with volunteers first',
    help: 'Organizers are only pulled into these roles when no volunteer is left.',
  },
  {
    key: 'enforceOncePerCategory',
    label: 'Avoid giving one person the same Room Help role twice',
    help: 'Spreads the room-helper duty around. Still allowed when there is nobody else — it is a preference, not a hard block.',
  },
];

export function RulesPanel({
  rules,
  onChange,
  onClose,
}: {
  rules: Rules;
  onChange: (rules: Rules) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Rules>) => onChange({ ...rules, ...patch });

  return (
    <Modal title="Assignment rules" onClose={onClose}>
      <p className="hint">
        Hard rules are never broken by the suggestion engine: availability, no double-booking, and never
        more people than a task needs. Everything below shapes the rest. You can always override any rule
        by assigning someone manually — the plan will just flag it as a warning.
      </p>

      <div className="rules-grid">
        {TOGGLES.map(({ key, label, help }) => (
          <div className="rule" key={key}>
            <input
              type="checkbox"
              id={key}
              checked={Boolean(rules[key])}
              onChange={(e) => set({ [key]: e.target.checked } as Partial<Rules>)}
            />
            <div>
              <label htmlFor={key}>{label}</label>
              <p>{help}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rule" style={{ marginTop: 16 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="balanceBy">Balance workload by</label>
          <select
            id="balanceBy"
            value={rules.balanceBy}
            style={{ marginTop: 4 }}
            onChange={(e) => set({ balanceBy: e.target.value as Rules['balanceBy'] })}
          >
            <option value="countThenHours">Number of shifts, hours as tie-break</option>
            <option value="hours">Total hours worked</option>
            <option value="count">Number of shifts only</option>
          </select>
        </div>
      </div>

      <div className="rule" style={{ marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="iterations">Search effort</label>
          <p>
            How many randomised attempts to make before picking the best plan. Higher fills more slots and
            balances better; 400 runs is effectively instant for an event this size.
          </p>
          <input
            id="iterations"
            type="number"
            min={1}
            max={5000}
            step={50}
            value={rules.iterations}
            style={{ marginTop: 4, width: 120 }}
            onChange={(e) => set({ iterations: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
      </div>
    </Modal>
  );
}
