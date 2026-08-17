/**
 * The browser half of auth.
 *
 * Separate from `supabase.ts` because that one imports `next/headers`, which a
 * client component may not pull in — the split is a hard requirement of the
 * runtime boundary, not an organisational preference.
 *
 * `isConfigured` lives here rather than there so both halves can share it: it
 * reads only NEXT_PUBLIC_ values and is safe in either environment.
 */

import { createBrowserClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * False on a deployment with no backend at all — which must stay a supported
 * way to run this app. Callers use it to tell "not signed in" apart from
 * "there is nothing to sign in to".
 */
export function isConfigured(): boolean {
  return Boolean(URL && ANON);
}

/** Client components. Safe to call on every render — the SDK memoises. */
export function browserClient() {
  if (!URL || !ANON) throw new Error("Supabase 没有配置。");
  return createBrowserClient(URL, ANON);
}
