import { useEffect, useState } from 'react';
import type { PlanState } from '../types';
import {
  nowInEventTz,
  eventPhase,
  runningNow,
  upNext,
  coworkers,
  parseNowOverride,
  type WallClock,
} from '../lib/clock';
import { fmtClock, fmtRange } from '../lib/time';

interface Props {
  state: PlanState;
  /** Optional person filter — shows only their shifts. */
  personId?: string;
}

export function NowView({ state, personId }: Props) {
  const override = parseNowOverride(window.location.search);
  const [now, setNow] = useState<WallClock>(() => nowInEventTz(override ?? undefined));

  useEffect(() => {
    if (override) {
      // Static override from ?now= parameter — no ticking
      setNow(nowInEventTz(override));
      return;
    }

    const tick = () => setNow(nowInEventTz());

    // Tick every 30s
    const id = setInterval(tick, 30_000);

    // Also refresh on visibility change — background tabs throttle timers,
    // so the interval alone shows stale time after a pocket trip.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [override]);

  const phase = eventPhase(state, now);
  const current = runningNow(state, now, personId);
  const next = upNext(state, now, personId);

  return (
    <div className="now-view">
      {override ? (
        <div className="now-banner">
          Simulated time: {now.date} {fmtClock(now.minutes)}
        </div>
      ) : null}

      <div className="now-clock">
        {fmtClock(now.minutes)} <span className="now-date">{now.date}</span>
      </div>

      {phase === 'before' ? <BeforeEvent state={state} now={now} /> : null}
      {phase === 'after' ? <AfterEvent /> : null}
      {phase === 'between-days' ? <BetweenDays /> : null}
      {phase === 'during' ? (
        <DuringEvent state={state} now={now} current={current} next={next} />
      ) : null}
    </div>
  );
}

function BeforeEvent({ state, now }: { state: PlanState; now: WallClock }) {
  const firstDate = state.days.map((d) => d.date).sort()[0];
  const daysUntil = firstDate ? daysBetween(now.date, firstDate) : null;

  return (
    <div className="now-phase-message">
      <h2>Event hasn't started yet</h2>
      {daysUntil !== null && daysUntil > 0 ? (
        <p>
          Starts in <strong>{daysUntil}</strong> day{daysUntil === 1 ? '' : 's'}
        </p>
      ) : (
        <p>Starts later today</p>
      )}
    </div>
  );
}

function AfterEvent() {
  return (
    <div className="now-phase-message">
      <h2>Event is over</h2>
      <p>Thanks for volunteering!</p>
    </div>
  );
}

function BetweenDays() {
  return (
    <div className="now-phase-message">
      <h2>Between event days</h2>
      <p>See you tomorrow!</p>
    </div>
  );
}

function DuringEvent({
  state,
  now,
  current,
  next,
}: {
  state: PlanState;
  now: WallClock;
  current: ReturnType<typeof runningNow>;
  next: ReturnType<typeof upNext>;
}) {
  // Split "next" into "up next" (first batch with the same start time) and "later today"
  const nextStart = next.length > 0 ? next[0].start : null;
  const upNextTasks = nextStart !== null ? next.filter((t) => t.start === nextStart) : [];
  const laterTasks = nextStart !== null ? next.filter((t) => t.start !== nextStart) : [];

  return (
    <>
      <Section title="On now" tasks={current} state={state} now={now} variant="now" />
      <Section title="Up next" tasks={upNextTasks} state={state} now={now} variant="next" />
      {laterTasks.length > 0 ? (
        <Section title="Later today" tasks={laterTasks} state={state} now={now} variant="later" />
      ) : null}
      {current.length === 0 && next.length === 0 ? (
        <div className="now-phase-message">
          <h2>No more shifts today</h2>
          <p>You're done for the day!</p>
        </div>
      ) : null}
    </>
  );
}

function Section({
  title,
  tasks,
  state,
  now,
  variant,
}: {
  title: string;
  tasks: ReturnType<typeof runningNow>;
  state: PlanState;
  now: WallClock;
  variant: 'now' | 'next' | 'later';
}) {
  if (tasks.length === 0) return null;

  return (
    <div className={`now-section now-section-${variant}`}>
      <h3>{title}</h3>
      <div className="now-cards">
        {tasks.map((task) => {
          const people = coworkers(state, task.id);
          const minutesUntil = task.start - now.minutes;

          return (
            <div key={task.id} className={`now-card now-card-${variant}`}>
              <div className="now-card-header">
                <span className="now-card-title">{task.title}</span>
                <span className="now-card-time">{fmtRange(task)}</span>
              </div>
              {variant === 'next' && minutesUntil > 0 ? (
                <div className="now-card-countdown">
                  in {minutesUntil} min
                </div>
              ) : null}
              {people.length > 0 ? (
                <div className="now-card-people">
                  {people.map((p) => (
                    <span key={p.personId} className="now-card-person">
                      {p.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="now-card-people now-card-nobody">No one assigned</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Simple date diff in days between two ISO date strings. */
function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}
