/**
 * The server half of auth.
 *
 * Auth exists in this app for exactly one reason: `/api/ai` spends real money
 * on a key we own, so it has to know who is calling. Nothing else needs a
 * server — the event log lives in IndexedDB and never leaves the device, and
 * that stays true after this file.
 *
 * Which means every function here has to survive Supabase not being configured
 * at all. A checkout with no `.env.local` must still run the whole notebook;
 * only the AI button goes dark.
 *
 * `server-only` makes a stray client import fail at build time rather than at
 * runtime in someone's browser — this module can reach the service role key.
 */

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isConfigured } from "./supabase-browser";

export { isConfigured };

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Server components and route handlers.
 *
 * `setAll` is wrapped because a Server Component cannot write cookies: the
 * refreshed token is dropped there and picked up by the middleware on the next
 * request instead, which is the documented arrangement, not a workaround.
 */
export async function serverClient() {
  if (!URL || !ANON) throw new Error("Supabase 没有配置。");
  const store = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            store.set(name, value, options);
          }
        } catch {
          /* Server Component: the middleware refreshes instead. */
        }
      },
    },
  });
}

/**
 * Service role: bypasses row-level security entirely.
 *
 * Only the AI gate uses it, and only to read the allowlist and write a usage
 * row. The key has no scope limits at all, so it must never reach anything
 * that renders in a browser.
 */
export function adminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !key) throw new Error("Supabase service role 没有配置。");
  return createClient(URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The signed-in user, or null. Never throws when unconfigured. */
export async function currentUser() {
  if (!isConfigured()) return null;
  const supabase = await serverClient();
  // getUser, not getSession: it revalidates against the auth server rather
  // than trusting a cookie the browser could have written.
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}
