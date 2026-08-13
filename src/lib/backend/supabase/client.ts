/**
 * Supabase client singleton.
 *
 * This module is the ONLY place that reads the Supabase env vars.
 * It is never imported in LOCAL mode or by selftest.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  if (!url || !key) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Set them in .env.local or as GitHub Actions variables.',
    );
  }

  client = createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

  return client;
}

/** The plan slug — hardcoded for now since the app supports one plan. */
export const PLAN_SLUG = 'cnda-2026';
