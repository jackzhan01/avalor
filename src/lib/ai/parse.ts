/**
 * Turning whatever the model actually said into a result the UI can render.
 *
 * Models return JSON "reliably" right up until they wrap it in a ```json fence,
 * prepend 好的，以下是分析, or hand back `"seat": "3号"` instead of `3`. All of
 * those are recoverable and none of them should cost the user their turn, so
 * this layer is deliberately forgiving — and equally deliberately strict about
 * the one thing that isn't recoverable: a payload with no usable content at all.
 *
 * Pure and synchronous, so the awkward cases are unit tests rather than
 * something you discover at the table.
 */

import type { AnalysisResult, SeatRead, SpeechResult } from "./types";

/** Strip a ```json fence and any prose either side of the outermost braces. */
export function extractJson(raw: string): string {
  let text = raw.trim();

  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  return text.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("模型返回的不是一个 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function parseObject(raw: string): Record<string, unknown> {
  const text = extractJson(raw);
  if (!text) throw new Error("模型没有返回内容");
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new Error("模型返回的内容不是合法 JSON");
  }
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/** Tolerates ["a","b"], "a\nb", and a single string. Drops empties. */
function strList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split("\n")
      : [];
  return items
    .map((item) => str(item).replace(/^[-•*·]\s*/, ""))
    .filter((item) => item.length > 0);
}

/** "3", 3 and "3号" all mean seat 3. Anything else is not a seat. */
function seatNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const match = str(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function confidence(value: unknown): SeatRead["confidence"] {
  const text = str(value).toLowerCase();
  if (text.startsWith("h") || text.includes("高") || text.includes("大")) {
    return "high";
  }
  if (text.startsWith("l") || text.includes("低") || text.includes("猜")) {
    return "low";
  }
  return "medium";
}

export function parseAnalysis(raw: string): AnalysisResult {
  const obj = parseObject(raw);

  const seats: SeatRead[] = [];
  const rows = Array.isArray(obj.seats) ? obj.seats : [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const cell = row as Record<string, unknown>;
    const seat = seatNumber(cell.seat);
    if (seat === null) continue;
    seats.push({
      seat,
      read: str(cell.read) || "不好说",
      confidence: confidence(cell.confidence),
      why: str(cell.why),
    });
  }
  seats.sort((a, b) => a.seat - b.seat);

  const headline = str(obj.headline);
  const keyPoints = strList(obj.keyPoints);

  // A response with no seats AND no takeaways carries nothing worth showing.
  // One or the other is enough — a partial answer still beats an error toast.
  if (seats.length === 0 && keyPoints.length === 0 && !headline) {
    throw new Error("模型返回的内容是空的");
  }

  return {
    headline: headline || "（模型没给出总体判断）",
    seats,
    keyPoints,
    ...(str(obj.watchOut) ? { watchOut: str(obj.watchOut) } : {}),
  };
}

export function parseSpeech(raw: string): SpeechResult {
  const obj = parseObject(raw);

  const outline = strList(obj.outline);
  if (outline.length === 0) throw new Error("模型没有给出发言要点");

  const avoid = strList(obj.avoid);
  return {
    stance: str(obj.stance),
    outline,
    ...(avoid.length ? { avoid } : {}),
  };
}
