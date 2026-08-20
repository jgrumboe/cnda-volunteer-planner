/** Starting state for a fresh or reset plan. Intentionally empty — no pre-loaded people or schedule. */

import { DEFAULT_RULES, type PlanState } from '../types';

export function createSeedState(): PlanState {
  return {
    version: 1,
    eventName: 'Cloud Native Days Austria 2026',
    days: [],
    people: [],
    tasks: [],
    assignments: [],
    rules: { ...DEFAULT_RULES },
  };
}
