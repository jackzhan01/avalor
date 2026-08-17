/**
 * Human-readable labels. Board-game vernacular (点车 / 上车 / 保 / 踩 / 上票 /
 * 下票), not rulebook translation — these are the words people actually use at
 * the table, and the app is read at a glance mid-conversation.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { RATING_LABELS } from "@/lib/selectors/opinions";

export function seatOf(game: GameRecord, playerId: string): number | null {
  return game.players.find((p) => p.id === playerId)?.seat ?? null;
}

/** "3号" — the primary way players refer to each other. */
export function seatLabel(game: GameRecord, playerId: string): string {
  const seat = seatOf(game, playerId);
  return seat == null ? "?" : `${seat}号`;
}

/** "3号 Jack" when a name was entered, otherwise just "3号". */
export function playerLabel(game: GameRecord, playerId: string): string {
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return "?";
  return player.name ? `${player.seat}号 ${player.name}` : `${player.seat}号`;
}

export function seatList(game: GameRecord, playerIds: readonly string[]): string {
  return playerIds
    .map((id) => seatOf(game, id))
    .filter((s): s is number => s != null)
    .sort((a, b) => a - b)
    .join(" · ");
}

export function ratingLabel(rating: number): string {
  return RATING_LABELS[rating] ?? String(rating);
}

/** One-line summary, used by the undo snackbar and compact timeline rows. */
export function describeEvent(event: GameEvent, game: GameRecord): string {
  switch (event.type) {
    case "opinion":
      return `${seatLabel(game, event.speakerId)} ${ratingLabel(event.rating)} ${seatLabel(game, event.targetId)}（${event.rating}）`;
    case "proposal":
      return `${seatLabel(game, event.leaderId)} 点车：${seatList(game, event.teamPlayerIds)}`;
    case "vote":
      return `投票结果：${event.finalResult === "passed" ? "车过了" : "车被否"}`;
    case "mission":
      return `第 ${event.missionNumber} 轮任务${event.result === "success" ? "成功" : "失败"}`;
    case "intended_team":
      return `${seatLabel(game, event.playerId)} 想带：${seatList(game, event.teamPlayerIds)}`;
    case "role_claim":
      return `${seatLabel(game, event.playerId)} ${event.claimed ? "跳派" : "收回跳派"}`;
    case "text":
      return event.playerId
        ? `${seatLabel(game, event.playerId)}：${event.text}`
        : event.text;
  }
}

export const EVENT_TYPE_LABELS: Record<GameEvent["type"], string> = {
  opinion: "保踩",
  proposal: "点车",
  vote: "投票",
  mission: "任务",
  intended_team: "意向车",
  role_claim: "跳派",
  text: "备注",
};

export function formatGameDate(iso: string): string {
  const d = new Date(iso);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hh}:${mm}`;
}
