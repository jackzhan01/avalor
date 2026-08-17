/**
 * Who is allowed to spend our money, and how much is left.
 *
 * `/api/ai` calls a provider with a key we pay for, on a public URL. An open
 * endpoint like that is not a hypothetical risk: crawlers look for exactly this
 * shape and resell what they find. So the gate's first job is not to manage
 * beta access — it is to make an anonymous request cost nothing.
 *
 * Four checks, cheapest first, so an attack is refused before it touches the
 * database:
 *
 *   1. kill switch   — one env var takes the feature offline everywhere
 *   2. signed in     — stops crawlers and anyone who merely found the URL
 *   3. allowlisted   — stops ordinary users who signed in out of curiosity
 *   4. under quota   — stops a beta user, or a shared account, running hot
 *
 * The budget is deliberately not self-healing: when the month's spend is used
 * up the feature stops until the calendar turns or the number is raised by
 * hand. A cap that quietly stretches is not a cap.
 */

import { adminClient, currentUser, isConfigured } from "./supabase";
import { NEEDS_LOGIN } from "./messages";

export type GateReason =
  | "unconfigured"
  | "off"
  | "anonymous"
  | "not_allowed"
  | "daily"
  | "budget"
  | "misconfigured";

export type GateResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string; reason: GateReason };

/** Per person, per UTC day. Generous enough to replay a real game. */
const DEFAULT_DAILY_REQUESTS = 20;
const DEFAULT_MONTHLY_BUDGET_USD = 50;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** USD per million tokens, as billed by whichever provider is configured. */
export function prices(): { input: number; output: number } {
  return {
    input: num("AI_PRICE_IN_PER_M", 0),
    output: num("AI_PRICE_OUT_PER_M", 0),
  };
}

export function costOf(promptTokens: number, completionTokens: number): number {
  const { input, output } = prices();
  return (promptTokens / 1e6) * input + (completionTokens / 1e6) * output;
}

function startOfUtcDay(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function startOfUtcMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Month-to-date spend across every user, in USD. */
export async function monthlySpend(): Promise<number> {
  const { data, error } = await adminClient()
    .from("ai_usage")
    .select("cost_usd")
    .gte("created_at", startOfUtcMonth());
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}

export async function checkAccess(): Promise<GateResult> {
  if (!isConfigured()) {
    return {
      ok: false,
      status: 503,
      reason: "unconfigured",
      error: "这个部署没有接后端，AI 功能用不了。",
    };
  }

  // Explicit opt-out only: an unset variable must not disable the feature by
  // accident, and a typo'd one must not enable it.
  if (process.env.AI_ENABLED === "false") {
    return {
      ok: false,
      status: 503,
      reason: "off",
      error: "AI 功能暂时关闭了。",
    };
  }

  const user = await currentUser();
  if (!user) {
    return {
      ok: false,
      status: 401,
      reason: "anonymous",
      error: `AI 功能${NEEDS_LOGIN}。`,
    };
  }

  const admin = adminClient();

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("ai_enabled")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return {
      ok: false,
      status: 500,
      reason: "misconfigured",
      error: "读取账号信息失败。",
    };
  }
  if (!profile?.ai_enabled) {
    return {
      ok: false,
      status: 403,
      reason: "not_allowed",
      error: "AI 功能还在内测，你的账号暂时没开通。",
    };
  }

  const dailyCap = num("AI_DAILY_REQUESTS", DEFAULT_DAILY_REQUESTS);
  const { count, error: countError } = await admin
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", startOfUtcDay());
  if (countError) {
    return {
      ok: false,
      status: 500,
      reason: "misconfigured",
      error: "读取用量失败。",
    };
  }
  if ((count ?? 0) >= dailyCap) {
    return {
      ok: false,
      status: 429,
      reason: "daily",
      error: `今天的 AI 额度用完了（每天 ${dailyCap} 次），明天再来。`,
    };
  }

  const budget = num("AI_MONTHLY_BUDGET_USD", DEFAULT_MONTHLY_BUDGET_USD);
  const { input, output } = prices();
  if (input <= 0 && output <= 0) {
    /*
     * Without a price the spend column is all zeroes, so the budget check
     * would pass forever. Refusing is the safe reading: a budget that cannot
     * be computed is not a budget, and silently serving would be exactly the
     * failure this gate exists to prevent.
     */
    return {
      ok: false,
      status: 503,
      reason: "misconfigured",
      error: "服务端没有配置模型单价，出于安全考虑 AI 功能已停用。",
    };
  }

  let spent: number;
  try {
    spent = await monthlySpend();
  } catch {
    return {
      ok: false,
      status: 500,
      reason: "misconfigured",
      error: "读取用量失败。",
    };
  }
  if (spent >= budget) {
    return {
      ok: false,
      status: 402,
      reason: "budget",
      error: "这个月的 AI 预算用完了，下个月自动恢复。",
    };
  }

  return { ok: true, userId: user.id };
}

/**
 * One row per completed call.
 *
 * Recorded after the provider answers, from the token counts it reports, so
 * the ledger reflects what is actually billed rather than what we guessed.
 * A failure to record is logged and swallowed: the user already has their
 * answer, and throwing here would turn a bookkeeping problem into a broken
 * feature. The row is lost, which the monthly total will under-count — the
 * alternative is worse.
 */
export async function recordUsage(
  userId: string,
  task: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): Promise<void> {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  try {
    const { error } = await adminClient().from("ai_usage").insert({
      user_id: userId,
      task,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: costOf(promptTokens, completionTokens),
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("[ai] 用量没记上", err);
  }
}
