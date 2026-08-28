/**
 * What a model client is, and the accounting every one of them must keep.
 *
 * The interface is one method. Everything interesting is in what the callers
 * are forbidden to do around it: no retry that changes the model, no fallback
 * to a scripted policy, no silent truncation to fit. Those live in
 * `core/run-status.ts::FORBIDDEN_REMEDIES` and the agent enforces them.
 *
 * THREE PROPERTIES, borrowed from `research/llm-client.ts`, which already
 * learned them the expensive way:
 *
 *   CACHED   an identical request returns the recorded answer, so re-running an
 *            evaluation costs nothing and the numbers are reproducible rather
 *            than re-sampled. A malformed answer is cached TOO — re-rolling
 *            until it parses reports a distribution the model does not have.
 *   CAPPED   a hard ceiling on live calls that throws rather than quietly
 *            spending more.
 *   COUNTED  usage comes from what the provider returned, never an estimate,
 *            and the ledger is written even when parsing the content fails.
 *
 * Nothing in this file opens a socket. `openai-responses.ts` is the only
 * module that does, and it is imported by exactly one script.
 */

import type { ReasoningEffort, SimConfig } from "../config/load";
import { checkCallBudget } from "../core/budget";
import type { PauseReason } from "../core/run-status";
import { FORBIDDEN_REMEDIES } from "../core/run-status";
import type { BudgetVerdict } from "../core/budget";
import { checkBudget } from "../core/budget";
import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  projectedRequestUsd,
  type TokenUsage,
} from "./pricing";

export interface JsonSchemaSpec {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface ModelRequest {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  /** Strict structured output. Every request this simulator makes uses one. */
  readonly format: JsonSchemaSpec;
  /** Extra provider knobs from config. Passed through untouched. */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly cached: boolean;
  /**
   * What the provider says it actually ran.
   *
   * Recorded separately from what was asked for, because a provider silently
   * serving a different snapshot is a thing that happens and would otherwise
   * be invisible in the trace.
   */
  readonly modelReturned: string;
  /** "incomplete" when the provider stopped early, e.g. at max output tokens. */
  readonly status: "completed" | "incomplete";
  readonly incompleteReason?: string;
}

export interface ModelClient {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * A sanitised provider failure.
 *
 * Carries the status, the provider's own error type and code, and a truncated
 * message — because "model not found" is the single most useful thing a
 * provider can say while a model name is being tried out. It carries NO
 * headers, no authorization data, no environment, and no request body. The
 * same line `/api/ai` draws.
 */
export class ModelCallError extends Error {
  constructor(
    readonly httpStatus: number | null,
    readonly providerType: string | null,
    readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }

  /** Safe to print, log and put in a trace. */
  describe(): string {
    const parts = [
      this.httpStatus === null ? "network" : `HTTP ${this.httpStatus}`,
      this.providerType ?? "",
      this.providerCode ?? "",
    ].filter(Boolean);
    return `${parts.join(" / ")}: ${this.message}`;
  }
}

/**
 * Could this failure plausibly succeed on a retry?
 *
 * Timeouts, dropped sockets, 408, 429 and 5xx are transient; everything else
 * — a bad schema, an unknown model, a rejected key — will fail again the same
 * way. The distinction decides whether a run is checkpointed for a human to
 * resume or marked failed, and it must NOT be used to retry automatically:
 * a request that timed out may or may not have been billed, and re-sending it
 * doubles a cost nobody can see.
 */
export function isRecoverableProviderError(error: ModelCallError): boolean {
  if (error.httpStatus === null) return true; // network or timeout
  if (error.httpStatus === 408 || error.httpStatus === 429) return true;
  return error.httpStatus >= 500;
}

/** Never let a provider message carry more than a line of context onward. */
export function safeMessage(raw: unknown, limit = 300): string {
  const text = typeof raw === "string" ? raw : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/* ── The ledger ────────────────────────────────────────────────────────── */

export interface Ledger {
  /** Requests actually sent to the provider. Counted when SENT, not on success. */
  readonly calls: number;
  /** Requests answered from cache, which cost nothing and were never sent. */
  readonly cached: number;
  /** Sent requests that threw. Already counted in `calls` — they were sent. */
  readonly failures: number;
  /** Answers that came back but could not be used. */
  readonly retries: number;
  readonly usage: TokenUsage;
  /** Null while pricing is unconfigured. Not zero — see `pricing.ts`. */
  readonly costUsd: number | null;
  readonly totalLatencyMs: number;
}

/**
 * Everything a ledger needs to come back after a pause.
 *
 * Plain data, so it round-trips through JSON in a checkpoint. Restoring this
 * is what makes a resumed game count against the SAME $25 ceiling rather than
 * starting the budget over — which would make every ceiling escapable by
 * pausing.
 */
export interface LedgerState {
  readonly calls: number;
  readonly cached: number;
  readonly failures: number;
  readonly retries: number;
  readonly usage: TokenUsage;
  readonly totalLatencyMs: number;
  readonly batchUsd: number;
}

/**
 * Money spent across a whole batch, shared by every game in it.
 *
 * Separate from `CallLedger` because the batch ceiling outlives any one game,
 * and a per-game ledger that also tried to own the batch total would either
 * duplicate it or lose it between games.
 */
export class BatchAccount {
  private usd = 0;

  constructor(startingUsd = 0) {
    this.add(startingUsd);
  }

  add(amount: number): void {
    if (Number.isFinite(amount) && amount > 0) this.usd += amount;
  }

  /**
   * Top this account up to at least `amount`, never past it.
   *
   * Restoring a checkpoint has to be idempotent and has to survive a caller
   * who supplied their own account. `add()` cannot do that job: calling it
   * twice with the same historical figure double-counts, and calling it on an
   * account that already knows about that spend inflates the batch total.
   *
   * "At least" rather than "set" because a batch account may legitimately hold
   * MORE than one game's checkpoint knows about — several games share it, and
   * the others' spend must not be erased by resuming this one.
   */
  ensureAtLeast(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (amount > this.usd) this.usd = amount;
  }

  spentUsd(): number {
    return this.usd;
  }
}

/** What `mayCall` decided, and everything a checkpoint would need. */
export interface SpendVerdict {
  readonly ok: boolean;
  readonly level: "ok" | "warn" | "stop";
  readonly reason: PauseReason | null;
  readonly detail: string;
  /** Already spent plus the worst case of the request being considered. */
  readonly projectedGameUsd: number | null;
  readonly projectedBatchUsd: number | null;
}

export interface NextRequestShape {
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Counts what a run has spent. Pure bookkeeping; it makes no requests itself.
 *
 * `spend()` is called after every attempt, successful or not, because charging
 * only for answers we could read would under-count exactly the calls worth
 * noticing — the same reason `/api/ai` records usage before it parses.
 */
export class CallLedger {
  private live = 0;
  private cachedHits = 0;
  private failed = 0;
  private retried = 0;
  private total: TokenUsage = emptyUsage();
  private latency = 0;
  private readonly batch: BatchAccount;

  constructor(
    private readonly config: SimConfig,
    batch: BatchAccount = new BatchAccount(),
  ) {
    this.batch = batch;
  }

  /**
   * Accepts anything carrying the three fields that cost something, so the
   * agent's own `CallRecord` can be fed straight in without a second shape.
   */
  /**
   * A request is about to go out. Counted HERE, not on success.
   *
   * The old accounting incremented only when a response arrived, so a request
   * that was sent and then timed out did not count against the call ceiling —
   * even though it was sent and may well have been billed. A run that kept
   * timing out could therefore exceed its cap indefinitely.
   */
  beginAttempt(): void {
    this.live += 1;
  }

  /**
   * The response arrived. Adds usage; does NOT count the call again.
   *
   * A cache hit is moved out of the live tally, because it never reached the
   * provider — `beginAttempt` optimistically assumed it would.
   */
  settleAttempt(response: Pick<ModelResponse, "usage" | "latencyMs" | "cached">): void {
    if (response.cached) {
      this.live -= 1;
      this.cachedHits += 1;
    }
    const before = estimateCostUsd(this.total, this.config.pricing) ?? 0;
    this.total = addUsage(this.total, response.usage);
    const after = estimateCostUsd(this.total, this.config.pricing) ?? 0;
    // The batch total moves with the game total, so a stopped game leaves the
    // batch ceiling holding the right number for whatever runs next.
    this.batch.add(after - before);
    this.latency += response.latencyMs;
  }

  /** An answer that came back but could not be used. The call still counts. */
  recordRetry(): void {
    this.retried += 1;
  }

  /**
   * A sent request that threw.
   *
   * Does not touch the live count: `beginAttempt` already counted it, and it
   * really was sent. Its token cost is UNKNOWN rather than zero — the provider
   * returned no usage object — so nothing is added to the totals, and the
   * attempt record says `usage: null` rather than pretending it was free.
   */
  failAttempt(): void {
    this.failed += 1;
  }

  spentThisGameUsd(): number | null {
    return estimateCostUsd(this.total, this.config.pricing);
  }

  /** A call that was sent and completed. The common case, in one step. */
  record(response: Pick<ModelResponse, "usage" | "latencyMs" | "cached">): void {
    this.beginAttempt();
    this.settleAttempt(response);
  }

  /** A call that was sent and threw. */
  recordFailure(): void {
    this.beginAttempt();
    this.failAttempt();
  }

  /** Everything needed to resume this ledger after a pause. */
  export(): LedgerState {
    return {
      calls: this.live,
      cached: this.cachedHits,
      failures: this.failed,
      retries: this.retried,
      usage: this.total,
      totalLatencyMs: this.latency,
      batchUsd: this.batch.spentUsd(),
    };
  }

  /**
   * Put a ledger back where it was.
   *
   * The batch account is NOT written here — it is constructed with the
   * restored total by the caller, so a batch shared by several games is not
   * double-credited by each of them restoring the same figure.
   */
  restore(state: LedgerState): void {
    this.live = state.calls;
    this.cachedHits = state.cached;
    this.failed = state.failures;
    this.retried = state.retries;
    this.total = state.usage;
    this.latency = state.totalLatencyMs;
  }

  snapshot(): Ledger {
    return {
      calls: this.live,
      cached: this.cachedHits,
      failures: this.failed,
      retries: this.retried,
      usage: this.total,
      costUsd: estimateCostUsd(this.total, this.config.pricing),
      totalLatencyMs: this.latency,
    };
  }

  /**
   * May another live call be made, and what would it do to the bill?
   *
   * Called BEFORE every request. Three ceilings, in order of how much damage
   * passing one does:
   *
   *   pricing unconfigured  →  stop. The money guard cannot see anything, and
   *                            running behind a blind gate is worse than
   *                            stopping in front of a visible one.
   *   call count            →  stop. Cheap, and catches a repair loop burning
   *                            calls before it has burned real money.
   *   projected spend       →  stop above the game or batch ceiling; warn at
   *                            the warning level.
   *
   * The projection prices the next request's input as fully UNCACHED and its
   * output at the cap, so it can only ever over-state. Both errors point the
   * same way on purpose: this decides whether to send at all.
   *
   * A verdict is RETURNED rather than thrown, so the caller can write a
   * resumable checkpoint before it stops.
   */
  mayCall(next: NextRequestShape): SpendVerdict {
    if (!this.config.pricing.configured) {
      return {
        ok: false,
        level: "stop",
        reason: "paused_pricing_unconfigured",
        detail:
          "价格未配置，预算闸看不见任何东西。先把 provider 的价目填进 config.pricing 再跑。",
        projectedGameUsd: null,
        projectedBatchUsd: null,
      };
    }

    const calls = checkCallBudget(this.live, this.config.limits);
    if (!calls.ok) {
      return {
        ok: false,
        level: "stop",
        reason: "paused_call_limit",
        detail: `已经调用 ${calls.calls} 次，本局上限 ${calls.limit}`,
        projectedGameUsd: this.spentThisGameUsd(),
        projectedBatchUsd: this.batch.spentUsd(),
      };
    }

    const increment =
      projectedRequestUsd(
        next.estimatedInputTokens,
        next.maxOutputTokens,
        this.config.pricing,
      ) ?? 0;
    const projectedGameUsd = (this.spentThisGameUsd() ?? 0) + increment;
    const projectedBatchUsd = this.batch.spentUsd() + increment;

    const verdict: BudgetVerdict = checkBudget(
      { gameUsd: projectedGameUsd, batchUsd: projectedBatchUsd },
      this.config.budget,
    );

    if (verdict.level === "stop") {
      const batchStop = verdict.triggeredBy === "batch_limit";
      return {
        ok: false,
        level: "stop",
        reason: verdict.runStatus,
        detail: batchStop
          ? `再发一次这批就到 $${projectedBatchUsd.toFixed(4)}，批量上限 $${this.config.budget.hardBatchCostLimitUsd}`
          : `再发一次本局就到 $${projectedGameUsd.toFixed(4)}，单局上限 $${this.config.budget.hardCostLimitPerGameUsd}`,
        projectedGameUsd,
        projectedBatchUsd,
      };
    }

    return {
      ok: true,
      level: verdict.level,
      reason: null,
      detail:
        verdict.level === "warn"
          ? `本局预计已到 $${projectedGameUsd.toFixed(4)}，越过提醒线 $${this.config.budget.costWarningPerGameUsd}`
          : "",
      projectedGameUsd,
      projectedBatchUsd,
    };
  }
}

export { FORBIDDEN_REMEDIES };

/* ── Caching ───────────────────────────────────────────────────────────── */

/**
 * A stable key for a request.
 *
 * Everything that could change the answer goes in, including the reasoning
 * effort and the schema — two runs at different effort levels are two
 * different experiments and must not share a cache entry. FNV-1a over the
 * whole thing; collisions are not a security concern here, only a correctness
 * one, and the field list is what makes them unlikely.
 */
export function requestKey(request: ModelRequest): string {
  const canonical = JSON.stringify([
    request.model,
    request.reasoningEffort,
    request.maxOutputTokens,
    request.format.name,
    request.format.schema,
    request.params ?? {},
    request.system,
    request.user,
  ]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Wrap any client in an in-memory cache.
 *
 * Deliberately in-memory rather than on disk at this milestone: a disk cache
 * shared between runs is exactly where a stale answer from an older prompt
 * version silently survives a change, and `requestKey` cannot see the prompt
 * version because the prompt text already encodes it. A persistent cache is a
 * later decision with its own invalidation story.
 */
export function cached(inner: ModelClient): ModelClient {
  const store = new Map<string, ModelResponse>();
  return {
    name: `cached(${inner.name})`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const key = requestKey(request);
      const hit = store.get(key);
      if (hit) return { ...hit, cached: true, latencyMs: 0 };
      const fresh = await inner.complete(request);
      // A refusal or a malformed answer is cached too: re-rolling it until it
      // parses would report a distribution the model does not actually have.
      store.set(key, fresh);
      return fresh;
    },
  };
}
