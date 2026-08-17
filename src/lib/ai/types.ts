/**
 * The wire contract between the browser and `/api/ai`, plus what the model is
 * asked to produce.
 *
 * The two result shapes are intentionally small. Everything the model returns
 * has to survive being rendered on a phone screen mid-game, glanced at in about
 * three seconds — so a field that can't be read at a glance is a field that
 * shouldn't exist.
 */

export type AiTask = "analysis" | "speech";

/** One seat's read. `read` is a short Chinese phrase, not an enum — see below. */
export interface SeatRead {
  seat: number;
  /**
   * Free text on purpose. A rigid enum would force "可能是坏人，但也可能是被做
   * 局的好人" into a bucket it doesn't fit, and the nuance is the useful part.
   * `readTone()` maps it to a colour for display.
   */
  read: string;
  confidence: "high" | "medium" | "low";
  why: string;
}

export interface AnalysisResult {
  headline: string;
  seats: SeatRead[];
  keyPoints: string[];
  watchOut?: string;
}

export interface SpeechResult {
  stance: string;
  outline: string[];
  avoid?: string[];
}

export interface AiRequest {
  task: AiTask;
  /** The rendered briefing. The server never derives it — see the route. */
  briefing: string;
  /** The user's own role, so the prompt can be tailored. */
  role?: string;
  /** Free-text steer for the speech task ("我想锤 4 号"). */
  extra?: string;
}

export type AiResponse =
  | { ok: true; task: "analysis"; result: AnalysisResult }
  | { ok: true; task: "speech"; result: SpeechResult }
  | { ok: false; error: string };

/**
 * Colour bucket for a free-text read.
 *
 * Order is load-bearing. 「不好说」 contains 「好」 and would otherwise be
 * painted green — an "I don't know" rendered as "he's good" is the one
 * mistranslation here that could actually cost someone the game — so the
 * hedges are matched first, before either side's keywords.
 */
export function readTone(read: string): "evil" | "good" | "neutral" | "self" {
  const text = read.trim();
  if (text.includes("我自己") || text === "我") return "self";
  if (/不好说|说不好|不确定|不清楚|看不出|存疑|中立/.test(text)) return "neutral";
  if (/莫甘娜|刺客|莫德雷德|奥伯伦|爪牙|坏/.test(text)) return "evil";
  if (/梅林|派西维尔|忠臣|好/.test(text)) return "good";
  return "neutral";
}

export const CONFIDENCE_LABEL: Record<SeatRead["confidence"], string> = {
  high: "把握大",
  medium: "一般",
  low: "只是猜",
};
