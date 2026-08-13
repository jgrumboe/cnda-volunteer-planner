import { useMemo, useState } from 'react';
import type { Assignment, PlanState } from '../types';
import type { Proposal } from '../lib/assign';
import { fmtClock } from '../lib/time';
import { Modal } from './Modal';

interface Props {
  state: PlanState;
  proposal: Proposal;
  onAccept: (accepted: Assignment[]) => void;
  onReshuffle: () => void;
  onClose: () => void;
}

export function ProposalDialog({ state, proposal, onAccept, onReshuffle, onClose }: Props) {
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const peopleById = useMemo(() => new Map(state.people.map((p) => [p.id, p])), [state.people]);
  const tasksById = useMemo(() => new Map(state.tasks.map((t) => [t.id, t])), [state.tasks]);

  const rowKey = (a: Assignment) => `${a.taskId}::${a.personId}`;

  const grouped = useMemo(() => {
    const byDay = new Map<string, Assignment[]>();
    for (const a of proposal.additions) {
      const t = tasksById.get(a.taskId);
      if (!t) continue;
      const list = byDay.get(t.dayId) ?? [];
      list.push(a);
      byDay.set(t.dayId, list);
    }
    for (const list of byDay.values()) {
      list.sort((x, y) => {
        const tx = tasksById.get(x.taskId)!;
        const ty = tasksById.get(y.taskId)!;
        return tx.start - ty.start || tx.title.localeCompare(ty.title);
      });
    }
    return byDay;
  }, [proposal.additions, tasksById]);

  const accepted = proposal.additions.filter((a) => !rejected.has(rowKey(a)));
  const unfilledTotal = proposal.unfilled.reduce((s, u) => s + u.count, 0);

  return (
    <Modal
      title="Suggested assignments"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn primary" onClick={() => onAccept(accepted)} disabled={accepted.length === 0}>
            Accept {accepted.length} assignment{accepted.length === 1 ? '' : 's'}
          </button>
          <button className="btn" onClick={onReshuffle}>
            Reshuffle
          </button>
          <div className="spacer" />
          {rejected.size > 0 ? (
            <button className="btn ghost" onClick={() => setRejected(new Set())}>
              Reset {rejected.size} rejected
            </button>
          ) : null}
        </>
      }
    >
      <p className="hint">
        Filled <strong>{proposal.additions.length}</strong> of {proposal.openSlotsBefore} open slots ·
        workload spread {proposal.spread.toFixed(2)} · best of {state.rules.iterations} runs. Pinned
        assignments were left untouched. Uncheck anything you don't want, then accept — accepted rows stay
        unpinned so a later reshuffle can still improve them.
      </p>

      {state.days.map((day) => {
        const list = grouped.get(day.id);
        if (!list || list.length === 0) return null;
        return (
          <div className="prop-group" key={day.id}>
            <h4>
              {day.label} {day.date} — {list.length} assignment{list.length === 1 ? '' : 's'}
            </h4>
            {list.map((a) => {
              const t = tasksById.get(a.taskId)!;
              const p = peopleById.get(a.personId);
              const key = rowKey(a);
              const isRejected = rejected.has(key);
              return (
                <div className={`prop-row ${isRejected ? 'rejected' : ''}`} key={key}>
                  <input
                    type="checkbox"
                    checked={!isRejected}
                    onChange={(e) => {
                      const next = new Set(rejected);
                      if (e.target.checked) next.delete(key);
                      else next.add(key);
                      setRejected(next);
                    }}
                  />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
                    {fmtClock(t.start)}–{fmtClock(t.end)}
                  </span>
                  <span style={{ flex: 1 }}>{t.title}</span>
                  <span className="who" style={{ flex: 0, whiteSpace: 'nowrap' }}>
                    <span className={`role-tag ${p?.isOrganizer ? 'org' : 'vol'}`}>
                      {p?.isOrganizer ? 'ORG' : 'VOL'}
                    </span>{' '}
                    {p?.name ?? 'unknown'}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}

      {unfilledTotal > 0 ? (
        <div className="prop-group">
          <h4>Could not fill {unfilledTotal} slot{unfilledTotal === 1 ? '' : 's'}</h4>
          <ul className="issues">
            {proposal.unfilled.map((u) => {
              const t = tasksById.get(u.taskId);
              const day = state.days.find((d) => d.id === t?.dayId);
              return (
                <li key={u.taskId} className="warn">
                  {day?.label} · {t?.title} — {u.count} slot{u.count === 1 ? '' : 's'} short.{' '}
                  {u.reasons.length > 0 ? `Everyone else: ${u.reasons.join(', ')}.` : 'Nobody eligible.'}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {proposal.additions.length === 0 && unfilledTotal === 0 ? (
        <div className="empty-state">Nothing to assign — every task is fully staffed.</div>
      ) : null}
    </Modal>
  );
}
