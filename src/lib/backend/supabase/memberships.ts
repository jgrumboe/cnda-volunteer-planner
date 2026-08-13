/**
 * Membership management — calls the manage_membership RPC.
 * Only usable by organizers (the RPC enforces this server-side).
 */

import { getSupabaseClient, PLAN_SLUG } from './client';

export interface Membership {
  email: string;
  role: 'organizer' | 'volunteer';
  personId: string | null;
}

/** Fetch all memberships for the current plan (organizer's own view via self-read + RPC). */
export async function listMemberships(planId: string): Promise<{ data: Membership[] | null; error: string | null }> {
  const supabase = getSupabaseClient();
  // Use a dedicated RPC to list all memberships (the self-read policy only returns your own row)
  const { data, error } = await supabase.rpc('list_memberships', { p_plan_id: planId });
  if (error) return { data: null, error: error.message };
  return {
    data: (data as { email: string; role: string; person_id: string | null }[]).map((r) => ({
      email: r.email,
      role: r.role as 'organizer' | 'volunteer',
      personId: r.person_id,
    })),
    error: null,
  };
}

export async function addMembership(
  planId: string,
  email: string,
  role: 'organizer' | 'volunteer',
  personId?: string | null,
): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('manage_membership', {
    p_plan_id: planId,
    p_action: 'add',
    p_email: email,
    p_role: role,
    p_person_id: personId ?? null,
  });
  return { error: error?.message ?? null };
}

export async function updateMembership(
  planId: string,
  email: string,
  role?: 'organizer' | 'volunteer',
  personId?: string | null,
): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('manage_membership', {
    p_plan_id: planId,
    p_action: 'update',
    p_email: email,
    p_role: role ?? null,
    p_person_id: personId ?? null,
  });
  return { error: error?.message ?? null };
}

export async function removeMembership(
  planId: string,
  email: string,
): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('manage_membership', {
    p_plan_id: planId,
    p_action: 'remove',
    p_email: email,
  });
  return { error: error?.message ?? null };
}

/** Get the plan_id by slug (needed to call membership RPCs). */
export async function getPlanId(): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase.from('plans').select('id').eq('slug', PLAN_SLUG).single();
  return data?.id ?? null;
}
