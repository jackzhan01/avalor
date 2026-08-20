/**
 * One seat's view of the game, in the exact form a model is allowed to see.
 *
 * The four-way comparison ahead — math-only, LLM-only, math plus social, and
 * the hybrid — is only worth running if every arm gets the same inputs. So
 * there is one place that decides what a seat knows, and it is here.
 *
 * The trick is that the notebook already has the right shape for this. A seat's
 * legitimate sight is exactly what the private layer records: `role_mark`
 * events with certainty "known", including `merlin_or_morgana` for the pair
 * Percival is shown. So a brief is the public log plus a reconstructed private
 * layer, handed to the same `buildBriefing` the product uses. No second
 * serialiser, and no second definition of what counts as private.
 *
 * What must never appear: the assignment, anyone else's role, or any social
 * evidence this seat was not in the room for. There is a test for each.
 */

import { buildBriefing } from "@/lib/ai/briefing";
import type { SocialEvidence } from "@/lib/social";
import { visibleTo } from "@/lib/social";
import type { GameEvent, RoleMark } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import type { InfoSet } from "./policy";
import { publicView } from "./public-view";

export interface SeatBrief {
  readonly seat: string;
  readonly game: GameRecord;
  readonly events: GameEvent[];
  /** What this seat may be asked to decide, already filtered to the legal set. */
  readonly legalTeams?: readonly (readonly string[])[];
  readonly proposedTeam?: readonly string[];
  readonly social: readonly SocialEvidence[];
}

/**
 * The private layer this seat is entitled to, as the events that would record
 * it if a person in that seat were keeping the notebook.
 */
function sightAsMarks(
  info: InfoSet,
  game: GameRecord,
  fromSequence: number,
): GameEvent[] {
  const seen: { targetId: string; mark: RoleMark }[] = [];

  // Merlin sees every evil but Mordred; an evil sees his teammates but never
  // Oberon. Both are already resolved in the information set, and neither is
  // recomputed here — one definition, in policy.ts.
  for (const target of info.visibleEvil) {
    seen.push({ targetId: target, mark: { kind: "side", side: "evil" } });
  }
  for (const target of info.knownEvil) {
    seen.push({ targetId: target, mark: { kind: "side", side: "evil" } });
  }
  // Percival is shown two seats and told one is Merlin. Unordered, and the
  // notebook has a mark for precisely this.
  for (const target of info.pair ?? []) {
    seen.push({ targetId: target, mark: { kind: "merlin_or_morgana" } });
  }

  return seen.map((entry, i) => ({
    id: `sight-${info.seat}-${i}`,
    gameId: game.id,
    type: "role_mark" as const,
    targetId: entry.targetId,
    mark: entry.mark,
    certainty: "known" as const,
    missionNumber: 1,
    sequence: fromSequence + i,
    timestamp: game.createdAt,
  }));
}

/**
 * Build the brief for one seat at one moment.
 *
 * `upTo` is the sequence the decision is being made at. Social evidence is
 * filtered by it and by audience, so a seat cannot hear what it was not there
 * for and cannot hear anything said after it had to decide.
 */
export function seatBrief(
  game: GameRecord,
  events: readonly GameEvent[],
  info: InfoSet,
  options: {
    upTo?: number;
    social?: readonly SocialEvidence[];
    legalTeams?: readonly (readonly string[])[];
    proposedTeam?: readonly string[];
  } = {},
): SeatBrief {
  const upTo = options.upTo ?? Number.MAX_SAFE_INTEGER;
  const visible = events.filter((e) => e.sequence <= upTo);
  // publicView is what already strips the private layer and clears the
  // viewer's role; the seat's own sight is then put back, and only its own.
  const view = publicView(visible as GameEvent[], game);
  const highest = view.events.reduce((m, e) => Math.max(m, e.sequence), 0);

  const asSeat: GameRecord = {
    ...view.game,
    viewerPlayerId: info.seat,
    viewerRole: info.role === "evil" || info.role === "oberon"
      ? info.role === "oberon"
        ? "oberon"
        : "minion"
      : info.role,
  };

  return {
    seat: info.seat,
    game: asSeat,
    events: [...view.events, ...sightAsMarks(info, asSeat, highest + 1)],
    legalTeams: options.legalTeams,
    proposedTeam: options.proposedTeam,
    social: (options.social ?? []).filter(
      (e) => e.sequence <= upTo && visibleTo(e, info.seat),
    ),
  };
}

/** What the table said, as the seat heard it. */
function renderSocial(brief: SeatBrief): string {
  if (!brief.social.length) return "";
  const seatOf = (id: string) =>
    `${brief.game.players.find((p) => p.id === id)?.seat ?? "?"}号`;
  const word = (v: number) =>
    v <= -0.6 ? "强踩" : v < -0.15 ? "踩" : v < 0.15 ? "中立" : v < 0.6 ? "保" : "强保";

  const lines = brief.social.map(
    (e) =>
      `第${e.missionNumber}轮 ${seatOf(e.speakerId)} 对 ${seatOf(e.targetId)}：${word(e.valence)}`,
  );
  return `## 场上发言（我听到的）\n${lines.join("\n")}`;
}

/** The brief as prose, which is what an LLM arm actually receives. */
export function renderBrief(
  brief: SeatBrief,
  options: { includeInference?: boolean } = {},
): string {
  const blocks = [
    // Derived conclusions are off by default here. Handing a language model
    // the inference layer's answers would make it a hybrid arm wearing the
    // language arm's name.
    buildBriefing(brief.game, brief.events, {
      includeInference: options.includeInference ?? false,
    }),
    renderSocial(brief),
  ];

  if (brief.proposedTeam?.length) {
    const seatOf = (id: string) =>
      `${brief.game.players.find((p) => p.id === id)?.seat ?? "?"}号`;
    blocks.push(
      `## 现在要我决定\n桌上这辆车是 ${brief.proposedTeam.map(seatOf).join("、")}。我该上票还是下票？`,
    );
  } else if (brief.legalTeams?.length) {
    blocks.push(
      `## 现在要我决定\n轮到我点车，要选 ${brief.legalTeams[0].length} 个人（可以包括我自己）。`,
    );
  }

  return blocks.filter(Boolean).join("\n\n");
}

/**
 * A decision maker for one seat.
 *
 * Deliberately narrow: the four arms differ in how they decide, not in what
 * they may look at, and this signature is what keeps that true.
 */
export interface SeatAgent {
  readonly name: string;
  approves(brief: SeatBrief): Promise<boolean>;
  picks(brief: SeatBrief): Promise<readonly string[]>;
}
