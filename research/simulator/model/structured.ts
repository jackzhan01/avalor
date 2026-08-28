/**
 * Turning whatever the model actually said into an `Action`.
 *
 * Strict structured output stops most of this at the provider, but "most" is
 * not "all": a model wraps JSON in a fence, prepends 好的，以下是我的回答, writes
 * `"3号"` where a number was asked for, or returns an empty string when a
 * safety filter fires. None of those should cost a game, so this layer is
 * deliberately forgiving about SHAPE — and equally deliberately strict about
 * the one thing that is not recoverable: a payload with nothing usable in it.
 *
 * WHAT IT DOES NOT DO is check the rules. Team size, Lady eligibility, whether
 * a seat is aboard, whether a villain may fail a quest — all of that belongs
 * to the referee, which already validates before mutating and therefore leaves
 * the game untouched when it rejects. Duplicating those checks here would
 * create a second, quieter rulebook. The agent's repair loop feeds the
 * referee's own message back to the model instead.
 *
 * Pure and synchronous, so every awkward case is a unit test rather than
 * something discovered mid-run at a dollar a call.
 */

import { GOOD_ROLES, EVIL_ROLES, type RoleType } from "@/lib/types/game";
import { isSeat } from "../core/order";
import type {
  Action,
  Belief,
  DecisionRequest,
  PrivateMemoryPatch,
  Seat,
  Stance,
} from "../core/types";

export type ParseResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly error: string };

const ALL_ROLES: readonly string[] = [...GOOD_ROLES, ...EVIL_ROLES];

/** Strip a ```json fence and any prose either side of the outermost braces. */
export function extractJson(raw: string): string {
  let text = (raw ?? "").trim();
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  return text.trim();
}

function asObject(raw: string): Record<string, unknown> | string {
  const text = extractJson(raw);
  if (!text) return "模型没有返回内容";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "返回的内容不是合法 JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "返回的不是一个 JSON 对象";
  }
  return value as Record<string, unknown>;
}

/** "3", 3 and "3号" all mean seat 3. Anything else is not a seat. */
function seat(value: unknown): Seat | null {
  if (typeof value === "number" && Number.isInteger(value) && isSeat(value)) return value;
  const match = typeof value === "string" ? value.match(/\d+/) : null;
  if (!match) return null;
  const n = Number(match[0]);
  return isSeat(n) ? n : null;
}

function seatList(value: unknown): Seat[] | null {
  if (!Array.isArray(value)) return null;
  const out: Seat[] = [];
  for (const item of value) {
    const s = seat(item);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function unit(value: unknown, lo: number, hi: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

/** One of a fixed set. Tolerates surrounding whitespace and case. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function stances(value: unknown, speaker: Seat): Stance[] {
  if (!Array.isArray(value)) return [];
  const out: Stance[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const cell = row as Record<string, unknown>;
    const s = seat(cell.seat);
    // A stance on yourself is dropped rather than rejected: the referee would
    // refuse the whole action, and losing a speech over one stray row is a
    // worse trade than losing the row.
    if (s === null || s === speaker) continue;
    const valence = unit(cell.valence, -1, 1);
    const confidence = unit(cell.confidence, 0, 1);
    if (valence === null) continue;
    out.push({ seat: s, valence, confidence: confidence ?? 0.5 });
  }
  return out;
}

function memoryPatch(value: unknown): PrivateMemoryPatch | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cell = value as Record<string, unknown>;
  const patch: { beliefs?: Belief[]; intentions?: string[]; commitments?: string[] } = {};

  if (Array.isArray(cell.beliefs)) {
    const beliefs: Belief[] = [];
    for (const row of cell.beliefs) {
      if (typeof row !== "object" || row === null) continue;
      const b = row as Record<string, unknown>;
      const s = seat(b.seat);
      const p = unit(b.pEvil, 0, 1);
      if (s === null || p === null) continue;
      beliefs.push({ seat: s, pEvil: p, note: text(b.note) ?? "" });
    }
    patch.beliefs = beliefs;
  }
  for (const key of ["intentions", "commitments"] as const) {
    const list = cell[key];
    if (!Array.isArray(list)) continue;
    patch[key] = list.map(text).filter((line): line is string => line !== null);
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function claim(value: unknown): RoleType | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ALL_ROLES.includes(raw) ? (raw as RoleType) : null;
}

/**
 * Attach the two fields every task shares.
 *
 * `rationale` is carried on the actions that declare it and dropped by the
 * referee elsewhere; it is a research annotation and never affects play, so a
 * stray one costs nothing while losing a real one would cost a trace.
 */
function withExtras<T extends Action>(base: T, cell: Record<string, unknown>): T {
  const patch = memoryPatch(cell.memoryPatch);
  const rationale = text(cell.rationale);
  return {
    ...base,
    ...(patch ? { memoryPatch: patch } : {}),
    ...(rationale ? { rationale } : {}),
  } as T;
}

/**
 * Parse one model answer against the request it was made for.
 *
 * The `request` is passed in rather than inferred from the payload, because a
 * model that answers the wrong question must be caught, not accommodated.
 */
export function parseAction(raw: string, request: DecisionRequest): ParseResult {
  const parsed = asObject(raw);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const cell = parsed;
  const fail = (error: string): ParseResult => ({ ok: false, error });

  switch (request.kind) {
    case "choose_opening_direction": {
      const ladySide = oneOf(cell.ladySide, ["left", "right"] as const);
      if (!ladySide) return fail("ladySide 必须是 left 或 right");
      const publicMessage = text(cell.publicMessage);
      if (publicMessage === null) return fail("缺少 publicMessage");
      return {
        ok: true,
        action: withExtras(
          { kind: "choose_opening_direction", ladySide, publicMessage },
          cell,
        ),
      };
    }

    case "speech": {
      const publicMessage = text(cell.publicMessage);
      if (publicMessage === null) return fail("缺少 publicMessage");
      const noTeamYet = cell.noTeamYet === true;
      const tentative = cell.tentativeTeam == null ? null : seatList(cell.tentativeTeam);
      if (cell.tentativeTeam != null && tentative === null) {
        return fail("tentativeTeam 里有不是座位的东西");
      }
      return {
        ok: true,
        action: withExtras(
          {
            kind: "speech",
            publicMessage,
            // Both given is a contradiction the referee rejects; resolving it
            // here would hide a model that did not read the instruction.
            tentativeTeam: tentative,
            noTeamYet,
            stances: stances(cell.stances, request.seat),
            claim: claim(cell.claim),
            // Only when true. An always-present `false` would put a key into
            // every replayed action of every game recorded before 0.4.0.
            ...(cell.retractClaim === true ? { retractClaim: true as const } : {}),
          },
          cell,
        ),
      };
    }

    case "leader_close_and_propose": {
      const publicMessage = text(cell.publicMessage);
      if (publicMessage === null) return fail("缺少 publicMessage");
      const team = seatList(cell.team);
      if (team === null) return fail("缺少 team，或者里面有不是座位的东西");
      return {
        ok: true,
        action: withExtras(
          { kind: "leader_close_and_propose", publicMessage, team },
          cell,
        ),
      };
    }

    case "vote": {
      const choice = oneOf(cell.choice, ["approve", "reject"] as const);
      if (!choice) return fail("choice 必须是 approve 或 reject");
      return { ok: true, action: withExtras({ kind: "vote", choice }, cell) as Action };
    }

    case "mission": {
      const card = oneOf(cell.card, ["success", "fail"] as const);
      if (!card) return fail("card 必须是 success 或 fail");
      return { ok: true, action: withExtras({ kind: "mission", card }, cell) as Action };
    }

    case "lady_select": {
      const target = seat(cell.target);
      if (target === null) return fail("target 不是合法座位");
      return {
        ok: true,
        action: withExtras({ kind: "lady_select", target }, cell) as Action,
      };
    }

    case "lady_announce": {
      const announced = oneOf(cell.announced, ["good", "evil"] as const);
      if (!announced) return fail("announced 必须是 good 或 evil");
      const publicMessage = text(cell.publicMessage);
      if (publicMessage === null) return fail("缺少 publicMessage");
      return {
        ok: true,
        action: withExtras(
          { kind: "lady_announce", announced, publicMessage },
          cell,
        ),
      };
    }

    case "evil_discuss": {
      const message = text(cell.message);
      if (message === null) return fail("缺少 message");
      return {
        ok: true,
        action: withExtras({ kind: "evil_discuss", message }, cell) as Action,
      };
    }

    case "assassinate": {
      const target = seat(cell.target);
      if (target === null) return fail("target 不是合法座位");
      return {
        ok: true,
        action: withExtras({ kind: "assassinate", target }, cell) as Action,
      };
    }
  }
}
