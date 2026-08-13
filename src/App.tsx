import { useCallback, useMemo, useState } from 'react';
import type { Assignment, Person, Rules, Task } from './types';
import { findConflicts, totalOpenSlots, withPrunedAssignments, type Conflict } from './lib/plan';
import { proposeAssignments, type Proposal } from './lib/assign';
import { createSeedState } from './lib/seed';
import { exportJson, exportPeopleCsv, exportTasksCsv } from './lib/exporters';
import { mergePeople } from './lib/importers';
import { BoardView } from './components/BoardView';
import { PeopleView } from './components/PeopleView';
import { TasksView } from './components/TasksView';
import { BalanceView } from './components/BalanceView';
import { ProposalDialog } from './components/ProposalDialog';
import { ImportDialog } from './components/ImportDialog';
import { RulesPanel } from './components/RulesPanel';
import { ConfirmButton } from './components/ConfirmButton';
import { NowView } from './components/NowView';
import { NotInvited } from './components/SignIn';
import { MyShiftsView } from './components/MyShiftsView';
import { AccessPanel } from './components/AccessPanel';
import { usePlan } from './lib/usePlan';
import { useAuth } from './lib/auth';
import { getBackendMode } from './lib/backend/index';

type Tab = 'mine' | 'now' | 'board' | 'people' | 'tasks' | 'balance';

const TABS: { id: Tab; label: string }[] = [
  { id: 'mine', label: 'My Shifts' },
  { id: 'now', label: 'Now' },
  { id: 'board', label: 'Board' },
  { id: 'people', label: 'People' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'balance', label: 'Warnings & Balance' },
];

export default function App() {
  const { state, setState, replacePlan, canEdit, connection, role, personId, error, setError } = usePlan();
  const auth = useAuth();
  // Volunteers land on "mine", organizers on "board"
  const [tab, setTab] = useState<Tab>(role === 'volunteer' ? 'mine' : 'board');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [thinking, setThinking] = useState(false);

  const { days, people, tasks, assignments, rules } = state;

  const conflicts = useMemo(
    () => findConflicts(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, people, tasks, assignments, rules],
  );
  const openSlots = useMemo(
    () => totalOpenSlots(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, assignments],
  );

  const conflictsByPerson = useMemo(() => {
    const map = new Map<string, Conflict[]>();
    for (const c of conflicts) {
      if (!c.personId) continue;
      const list = map.get(c.personId) ?? [];
      list.push(c);
      map.set(c.personId, list);
    }
    return map;
  }, [conflicts]);

  const understaffedTaskIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assignments) counts.set(a.taskId, (counts.get(a.taskId) ?? 0) + 1);
    return new Set(tasks.filter((t) => (counts.get(t.id) ?? 0) < t.needed).map((t) => t.id));
  }, [assignments, tasks]);

  const assign = useCallback((taskId: string, personId: string) => {
    setState((s) =>
      s.assignments.some((a) => a.taskId === taskId && a.personId === personId)
        ? s
        : { ...s, assignments: [...s.assignments, { taskId, personId, pinned: true, source: 'manual' }] },
    );
  }, [setState]);

  const unassign = useCallback((taskId: string, personId: string) => {
    setState((s) => ({
      ...s,
      assignments: s.assignments.filter((a) => !(a.taskId === taskId && a.personId === personId)),
    }));
  }, [setState]);

  const togglePin = useCallback((taskId: string, personId: string) => {
    setState((s) => ({
      ...s,
      assignments: s.assignments.map((a) =>
        a.taskId === taskId && a.personId === personId ? { ...a, pinned: !a.pinned } : a,
      ),
    }));
  }, [setState]);

  const suggest = (seed = Date.now()) => {
    setThinking(true);
    // Yield to the event loop so the button repaints before the search blocks it.
    // setTimeout rather than requestAnimationFrame: rAF is paused in background
    // tabs, which would leave the button stuck on "Searching…".
    setTimeout(() => {
      try {
        setProposal(proposeAssignments(state, seed));
      } catch (err) {
        console.error('Assignment search failed', err);
        setError(`Could not compute suggestions: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setThinking(false);
      }
    }, 0);
  };

  /**
   * Apply a proposal, re-validating it against current state rather than trusting it.
   * The proposal was scored against a snapshot; anything that no longer holds is dropped
   * instead of being appended blindly.
   */
  const acceptProposal = (accepted: Assignment[]) => {
    setState((s) => {
      const taskIds = new Set(s.tasks.map((t) => t.id));
      const peopleIds = new Set(s.people.map((p) => p.id));
      const needed = new Map(s.tasks.map((t) => [t.id, t.needed]));
      const keep = s.assignments.filter((a) => a.pinned);

      const filled = new Map<string, number>();
      const taken = new Set<string>();
      for (const a of keep) {
        filled.set(a.taskId, (filled.get(a.taskId) ?? 0) + 1);
        taken.add(`${a.taskId}::${a.personId}`);
      }

      const added: Assignment[] = [];
      for (const a of accepted) {
        if (!taskIds.has(a.taskId) || !peopleIds.has(a.personId)) continue;
        const key = `${a.taskId}::${a.personId}`;
        if (taken.has(key)) continue;
        const count = filled.get(a.taskId) ?? 0;
        if (count >= (needed.get(a.taskId) ?? 0)) continue;
        filled.set(a.taskId, count + 1);
        taken.add(key);
        added.push(a);
      }

      const dropped = accepted.length - added.length;
      if (dropped > 0) {
        console.warn(`Dropped ${dropped} suggested assignment(s) that no longer apply.`);
      }
      return { ...s, assignments: [...keep, ...added] };
    });
    setProposal(null);
  };

  const applyImport = (people: Person[], tasks: Task[], replaceTasks: boolean) => {
    setState((s) => {
      // Merged against `s`, not against render-time state, so a person added while
      // the dialog was open is preserved. mergePeople is additive — it never prunes.
      const merged = mergePeople(s.people, people);
      return withPrunedAssignments({
        ...s,
        people: merged.people,
        tasks: tasks.length > 0 && replaceTasks ? tasks : [...s.tasks, ...tasks],
        assignments: tasks.length > 0 && replaceTasks ? [] : s.assignments,
      });
    });
    setShowImport(false);
  };

  const resetAll = () => {
    replacePlan(createSeedState());
    setError(null);
  };

  const clearSuggestions = () => {
    setState((s) => ({ ...s, assignments: s.assignments.filter((a) => a.pinned) }));
  };

  const suggestedCount = state.assignments.filter((a) => !a.pinned).length;
  const problems = conflicts.length;

  // Not a member — show dedicated screen
  if (error === 'not_a_member' && auth.session) {
    return <NotInvited email={auth.session.email} onSignOut={auth.signOut} />;
  }

  // Still loading in remote mode
  if (connection === 'connecting' && !state.days.length) {
    return (
      <div className="signin-container">
        <div className="signin-card">
          <p style={{ color: 'var(--muted)' }}>Loading plan...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <strong>{state.eventName}</strong>
          <span>Volunteer &amp; task planner · {getBackendMode() === 'local' ? 'data stays in this browser' : 'live · shared with your team'}</span>
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'balance' && problems > 0 ? ` (${problems})` : ''}
            </button>
          ))}
        </nav>

        <button
          className={`warn-chip ${problems > 0 ? 'bad' : openSlots > 0 ? '' : 'ok'}`}
          style={{ cursor: 'pointer', background: 'none' }}
          onClick={() => setTab('balance')}
          title="Click for the full list"
        >
          {problems > 0 ? `${problems} rule breach${problems === 1 ? '' : 'es'} · ` : ''}
          {openSlots > 0 ? `${openSlots} slot${openSlots === 1 ? '' : 's'} unfilled` : 'fully staffed'}
        </button>

        <div className="spacer" />

        {canEdit ? (
          <div className="actions">
            <button className="btn primary" onClick={() => suggest()} disabled={thinking || openSlots === 0}>
              {thinking ? 'Searching…' : 'Assign open tasks'}
            </button>
            {suggestedCount > 0 ? (
              <button className="btn ghost" onClick={clearSuggestions} title="Remove all unpinned suggestions">
                Clear {suggestedCount} suggested
              </button>
            ) : null}
            <button className="btn" onClick={() => setShowRules(true)}>
              Rules
            </button>
            <button className="btn" onClick={() => setShowAccess(true)}>
              Access
            </button>
            <button className="btn" onClick={() => setShowImport(true)}>
              Import
            </button>
            <button className="btn" onClick={() => exportTasksCsv(state)} title="Tasks with assigned people, as CSV">
              Export tasks
            </button>
            <button className="btn" onClick={() => exportPeopleCsv(state)} title="Per-person schedule, as CSV">
              Export people
            </button>
            <button className="btn ghost" onClick={() => exportJson(state)} title="Full backup you can re-import">
              Backup
            </button>
            <ConfirmButton
              className="btn ghost danger"
              label="Reset"
              question="Discard this plan and start from the seed data?"
              confirmLabel="Yes, reset"
              danger
              onConfirm={resetAll}
            />
          </div>
        ) : (
          <div className="actions">
            <button className="btn" onClick={() => exportTasksCsv(state)} title="Tasks with assigned people, as CSV">
              Export tasks
            </button>
            <button className="btn" onClick={() => exportPeopleCsv(state)} title="Per-person schedule, as CSV">
              Export people
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div className="error-strip">
          <span>{error}</span>
          <button className="btn tiny ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="content">
        {tab === 'mine' ? <MyShiftsView state={state} personId={personId} /> : null}
        {tab === 'now' ? <NowView state={state} /> : null}
        {tab === 'board' ? (
          <BoardView
            state={state}
            canEdit={canEdit}
            conflictsByPerson={conflictsByPerson}
            understaffedTaskIds={understaffedTaskIds}
            onAssign={assign}
            onUnassign={unassign}
            onTogglePin={togglePin}
          />
        ) : null}
        {tab === 'people' ? (
          <PeopleView
            state={state}
            canEdit={canEdit}
            onChange={(people) => setState((s) => withPrunedAssignments({ ...s, people }))}
          />
        ) : null}
        {tab === 'tasks' ? (
          <TasksView
            state={state}
            canEdit={canEdit}
            onChange={(tasks) => setState((s) => withPrunedAssignments({ ...s, tasks }))}
          />
        ) : null}
        {tab === 'balance' ? <BalanceView state={state} /> : null}
      </div>

      {proposal ? (
        <ProposalDialog
          state={state}
          proposal={proposal}
          onAccept={acceptProposal}
          onReshuffle={() => suggest(Math.floor(Math.random() * 2 ** 31))}
          onClose={() => setProposal(null)}
        />
      ) : null}

      {showImport ? (
        <ImportDialog
          state={state}
          onApply={applyImport}
          onRestore={(restored) => {
            replacePlan(restored);
            setShowImport(false);
          }}
          onClose={() => setShowImport(false)}
        />
      ) : null}

      {showRules ? (
        <RulesPanel
          rules={state.rules}
          onChange={(rules: Rules) => setState((s) => ({ ...s, rules }))}
          onClose={() => setShowRules(false)}
        />
      ) : null}

      {showAccess ? (
        <AccessPanel
          state={state}
          onClose={() => setShowAccess(false)}
        />
      ) : null}
    </div>
  );
}
