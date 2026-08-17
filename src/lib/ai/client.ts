/**
 * Browser side of the AI feature, and the fork between the two paths:
 *
 *   own key set  →  browser ──────────────────────────────→ provider
 *   no own key   →  browser → our /api/ai (holds our key) → provider
 *
 * The briefing is built HERE in both cases, because the event log only exists
 * here — it lives in IndexedDB and has never left the device. That is also
 * what makes the privacy story checkable: `buildBriefing` is a pure function
 * whose exact output is what gets sent, and the sheet can show the user those
 * same bytes before they agree to send them.
 *
 * On the BYOK path nothing whatsoever touches our servers: not the key, not
 * the briefing, not the result.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, RoleType } from "@/lib/types/game";
import { buildBriefing } from "./briefing";
import { loadByok, type ByokConfig } from "./byok";
import { completeDirect } from "./direct";
import { parseAnalysis, parseSpeech } from "./parse";
import {
  analysisSystemPrompt,
  analysisUserPrompt,
  speechSystemPrompt,
  speechUserPrompt,
} from "./prompts";
import type { AiResponse, AnalysisResult, SpeechResult } from "./types";

/** Below this there is nothing to reason about and the model will just guess. */
const MIN_EVENTS = 3;

export function hasEnoughToAnalyze(events: GameEvent[]): boolean {
  return events.length >= MIN_EVENTS;
}

/** Which path a request will take, for wording the consent screen honestly. */
export type AiRoute = "own-key" | "our-key";

export function currentRoute(): AiRoute {
  return loadByok() ? "own-key" : "our-key";
}

/* ── Our key: through the server route ─────────────────────────────────── */

async function viaServer(payload: {
  task: "analysis" | "speech";
  briefing: string;
  role?: string;
  extra?: string;
}): Promise<AiResponse> {
  let response: Response;
  try {
    response = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Offline is the expected case at a real table — the app itself works
    // without a network, so this is worth naming precisely.
    return { ok: false, error: "网络连不上，AI 功能需要联网。" };
  }

  try {
    return (await response.json()) as AiResponse;
  } catch {
    return { ok: false, error: `请求失败（${response.status}）。` };
  }
}

/* ── Own key: straight from this browser ───────────────────────────────── */

async function viaOwnKey(
  config: ByokConfig,
  task: "analysis" | "speech",
  briefing: string,
  role: RoleType | undefined,
  extra?: string,
): Promise<string> {
  const system =
    task === "analysis"
      ? analysisSystemPrompt(role)
      : speechSystemPrompt(role);
  const user =
    task === "analysis"
      ? analysisUserPrompt(briefing)
      : speechUserPrompt(briefing, extra);
  return completeDirect(config, system, user);
}

/* ── Public API ────────────────────────────────────────────────────────── */

export async function requestAnalysis(
  game: GameRecord,
  events: GameEvent[],
): Promise<AnalysisResult> {
  const briefing = buildBriefing(game, events);
  const byok = loadByok();

  if (byok) {
    return parseAnalysis(
      await viaOwnKey(byok, "analysis", briefing, game.viewerRole),
    );
  }

  const response = await viaServer({
    task: "analysis",
    briefing,
    role: game.viewerRole,
  });
  if (!response.ok) throw new Error(response.error);
  if (response.task !== "analysis") throw new Error("返回的结果类型不对。");
  return response.result;
}

export async function requestSpeech(
  game: GameRecord,
  events: GameEvent[],
  extra?: string,
): Promise<SpeechResult> {
  const briefing = buildBriefing(game, events);
  const byok = loadByok();

  if (byok) {
    return parseSpeech(
      await viaOwnKey(byok, "speech", briefing, game.viewerRole, extra),
    );
  }

  const response = await viaServer({
    task: "speech",
    briefing,
    role: game.viewerRole,
    ...(extra ? { extra } : {}),
  });
  if (!response.ok) throw new Error(response.error);
  if (response.task !== "speech") throw new Error("返回的结果类型不对。");
  return response.result;
}
