/**
 * Supabase backend implementation.
 *
 * Handles: initial load via get_plan RPC, row-level writes via PostgREST,
 * atomic replacements via replace_plan RPC, and realtime subscriptions.
 */

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { PlanState } from '../../../types';
import type { PlanBackend, RowOp, SyncError, ConnectionState, AllClocks, RowClocks } from '../types';
import { normalize } from '../../storage';
import { getSupabaseClient, PLAN_SLUG } from './client';
import {
  rowOpToTable,
  rowOpToDbPayload,
  rowOpToDeleteMatch,
  realtimeRowId,
  dbDayToDomain,
  dbPersonToDomain,
  dbTaskToDomain,
  dbAssignmentToDomain,
  type DbDay,
  type DbPerson,
  type DbTask,
  type DbAssignment,
} from './map';
import { mergeInbound, type InboundEvent } from '../merge';

interface PlanMeta {
  planId: string;
  revision: number;
  role: 'organizer' | 'volunteer';
  personId: string | null;
}

export function createSupabaseBackend(): PlanBackend {
  const supabase: SupabaseClient = getSupabaseClient();
  let connection: ConnectionState = 'connecting';
  let meta: PlanMeta | null = null;
  let channel: RealtimeChannel | null = null;
  let subscriberCallback: ((state: PlanState) => void) | null = null;
  let currentState: PlanState | null = null;
  let clocks: AllClocks = {
    days: new Map(),
    people: new Map(),
    tasks: new Map(),
    assignments: new Map(),
  };

  function setConnection(c: ConnectionState) {
    connection = c;
  }

  function parseClocks(raw: Record<string, Record<string, string>>): AllClocks {
    const parse = (obj: Record<string, string>): RowClocks => new Map(Object.entries(obj ?? {}));
    return {
      days: parse(raw.days),
      people: parse(raw.people),
      tasks: parse(raw.tasks),
      assignments: parse(raw.assignments),
    };
  }

  async function load(): Promise<PlanState> {
    setConnection('connecting');

    const { data, error } = await supabase.rpc('get_plan', { p_slug: PLAN_SLUG });
    if (error) {
      setConnection('error');
      throw new Error(`get_plan failed: ${error.message}`);
    }
    if (!data) {
      setConnection('error');
      throw new Error('Plan not found. Check PLAN_SLUG and ensure a plans row exists.');
    }
    if (data.error === 'not_a_member') {
      setConnection('error');
      throw new Error('not_a_member');
    }

    meta = {
      planId: data.planId,
      revision: data.revision,
      role: data.role,
      personId: data.personId ?? null,
    };
    clocks = parseClocks(data.clocks);
    currentState = normalize(data.state);
    setConnection('live');
    return currentState;
  }

  async function push(ops: RowOp[]): Promise<SyncError[]> {
    if (!meta) return [{ code: 'NO_META', message: 'Not loaded yet', retryable: false }];
    const errors: SyncError[] = [];

    for (const op of ops) {
      const table = rowOpToTable(op);
      let result;

      if (op.type === 'delete') {
        const match = rowOpToDeleteMatch(op, meta.planId);
        result = await supabase.from(table).delete().match(match);
      } else {
        const payload = rowOpToDbPayload(op, meta.planId);
        if (!payload) continue;
        // Upsert with the composite PK
        result = await supabase.from(table).upsert(payload, { onConflict: pkColumns(op.collection) });
      }

      if (result.error) {
        errors.push({
          code: result.error.code ?? 'UNKNOWN',
          message: result.error.message,
          rowIds: [op.id],
          retryable: isRetryable(result.error.code),
        });
      }
    }

    return errors;
  }

  async function replacePlan(state: PlanState): Promise<SyncError | null> {
    if (!meta) return { code: 'NO_META', message: 'Not loaded yet', retryable: false };

    const { data, error } = await supabase.rpc('replace_plan', {
      p_plan_id: meta.planId,
      payload: { state },
    });

    if (error) {
      return {
        code: error.code ?? 'UNKNOWN',
        message: error.message,
        retryable: isRetryable(error.code),
      };
    }

    if (data) {
      meta.revision = data as number;
    }
    currentState = state;
    return null;
  }

  function subscribe(callback: (state: PlanState) => void): () => void {
    subscriberCallback = callback;

    if (!meta) return () => { subscriberCallback = null; };

    channel = supabase
      .channel(`plan:${meta.planId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', filter: `plan_id=eq.${meta.planId}` },
        (payload) => {
          handleRealtimeEvent(payload);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setConnection('live');
        if (status === 'CHANNEL_ERROR') setConnection('readonly');
        if (status === 'CLOSED') setConnection('readonly');
      });

    // Refresh socket auth on token refresh
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' && channel) {
        supabase.realtime.setAuth(
          (supabase.auth as unknown as { currentSession?: { access_token: string } }).currentSession?.access_token ?? '',
        );
      }
    });

    return () => {
      subscriberCallback = null;
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    };
  }

  function handleRealtimeEvent(payload: Record<string, unknown>) {
    if (!currentState || !subscriberCallback) return;

    const eventType = payload.eventType as string;
    const table = payload.table as string;
    const collection = tableToCollection(table);
    if (!collection) return;

    let event: InboundEvent;

    if (eventType === 'DELETE') {
      const old = payload.old as Record<string, unknown>;
      const id = realtimeRowId(collection, old);
      event = { collection, type: 'delete', id };
    } else {
      // INSERT or UPDATE
      const row = payload.new as Record<string, unknown>;
      const id = realtimeRowId(collection, row);
      const domain = rowToDomain(collection, row);
      const timestamp = row.updated_at as string | undefined;
      event = {
        collection,
        type: 'upsert',
        id,
        payload: domain as unknown as Record<string, unknown>,
        timestamp,
      };
    }

    const next = mergeInbound(currentState, event, { clocks });
    if (next !== currentState) {
      currentState = next;
      // Update clock for the affected row
      if (event.type === 'upsert' && event.timestamp) {
        clocks[collection].set(event.id, event.timestamp);
      } else if (event.type === 'delete') {
        clocks[collection].delete(event.id);
      }
      subscriberCallback(next);
    }
  }

  function flush(): void {
    // In a real implementation, this would use fetch with keepalive.
    // For now, the rowsync layer handles flushing before this is called.
  }

  function destroy(): void {
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
  }

  return {
    get connection() { return connection; },
    load,
    push,
    replacePlan,
    subscribe,
    flush,
    destroy,
  };
}

// ---------------------------------------------------------------- helpers

function pkColumns(collection: string): string {
  switch (collection) {
    case 'days': return 'plan_id,id';
    case 'people': return 'plan_id,id';
    case 'tasks': return 'plan_id,id';
    case 'assignments': return 'plan_id,task_id,person_id';
    default: return 'plan_id,id';
  }
}

function tableToCollection(table: string): 'days' | 'people' | 'tasks' | 'assignments' | null {
  switch (table) {
    case 'days': return 'days';
    case 'people': return 'people';
    case 'tasks': return 'tasks';
    case 'assignments': return 'assignments';
    default: return null;
  }
}

function rowToDomain(collection: string, row: Record<string, unknown>): unknown {
  switch (collection) {
    case 'days': return dbDayToDomain(row as unknown as DbDay);
    case 'people': return dbPersonToDomain(row as unknown as DbPerson);
    case 'tasks': return dbTaskToDomain(row as unknown as DbTask);
    case 'assignments': return dbAssignmentToDomain(row as unknown as DbAssignment);
    default: return row;
  }
}

function isRetryable(code: string | undefined): boolean {
  if (!code) return true;
  // Terminal errors that should not be retried
  const terminal = new Set(['42501', '23503', '23505', 'P0001', 'P0002']);
  return !terminal.has(code);
}
