import { describe, expect, it } from "vitest";
import { PROFILES, scriptedTable, type ScriptedProfile } from "../agents/scripted-agent";
import { drive } from "../fixtures/harness";
import { checkInvariants } from "../fixtures/invariants";
import type { GameEndReason } from "../core/events";

/**
 * A thousand complete games, every one checked against every rule.
 *
 * This is the reason scripted agents exist. A language model cannot be run a
 * thousand times in a unit test, and a referee that has only ever been walked
 * through a handful of hand-written positions has only been tested in the
 * positions somebody thought of. The profiles below between them drive the
 * table into every corner the rules have: quests that fail, quests that evil
 * deliberately passes, rejection tracks that run to five, Lady holders who lie,
 * assassins who hit and assassins who miss.
 *
 * Every game is asserted to TERMINATE and to satisfy `checkInvariants`, which
 * recomputes the quest track, the vote arithmetic, the speaking order, the
 * Lady chain and the ending from the public log rather than trusting the
 * referee's own counters.
 */

const GAMES = 1000;

/**
 * Rotate profiles by seed so the thousand games are not a thousand runs of one
 * table. The cycle length is coprime with nothing in particular; it just has to
 * mix.
 */
const ROTATION: readonly ScriptedProfile[] = [
  PROFILES.mixed,
  PROFILES.mixed,
  PROFILES.mixed,
  PROFILES.agreeable,
  PROFILES.passiveEvil,
  PROFILES.truthfulLeft,
  PROFILES.mixed,
  PROFILES.lyingRight,
  PROFILES.contrarian,
];

describe(`${GAMES} seeded scripted games`, () => {
  it("all terminate legally, with every invariant intact", () => {
    const violations: string[] = [];
    const endings = new Map<GameEndReason, number>();
    const winners = new Map<string, number>();
    let questsPlayed = 0;
    let ladyChecks = 0;
    let ladyLies = 0;
    let longestGame = 0;

    for (let seed = 1; seed <= GAMES; seed += 1) {
      const profile = ROTATION[seed % ROTATION.length];
      const { state, actions } = drive({
        seed,
        agents: scriptedTable({ seed, profile }),
        profile,
      });

      const outcome = state.outcome;
      if (!outcome) {
        violations.push(`seed ${seed} (${profile.name}): did not terminate`);
        continue;
      }

      for (const problem of checkInvariants(state, actions)) {
        violations.push(`seed ${seed} (${profile.name}): ${problem}`);
      }

      endings.set(outcome.reason, (endings.get(outcome.reason) ?? 0) + 1);
      winners.set(outcome.winner, (winners.get(outcome.winner) ?? 0) + 1);
      questsPlayed += state.log.filter((e) => e.type === "mission_result").length;
      ladyChecks += state.ladyChecks;
      longestGame = Math.max(longestGame, actions.length);

      for (const said of state.log) {
        if (said.type !== "lady_announced") continue;
        const truth = state.deal.evilSeats.includes(said.target) ? "evil" : "good";
        if (said.announced !== truth) ladyLies += 1;
      }
    }

    // Print the shape of the sweep, so a change in coverage is visible in the
    // output rather than only when an assertion happens to trip.
    console.log(
      `\n${GAMES} 局：结局分布 ${[...endings]
        .map(([reason, n]) => `${reason} ${n}`)
        .join("，")}`,
    );
    console.log(
      `好人 ${winners.get("good") ?? 0} / 坏人 ${winners.get("evil") ?? 0}，` +
        `共 ${questsPlayed} 轮任务，${ladyChecks} 次验人（其中 ${ladyLies} 次说了谎），` +
        `最长一局 ${longestGame} 个动作`,
    );

    expect(violations.slice(0, 20)).toEqual([]);
    expect(violations).toHaveLength(0);
  });

  it("covers every way a game can end", () => {
    const endings = new Set<GameEndReason>();
    for (let seed = 1; seed <= GAMES; seed += 1) {
      const profile = ROTATION[seed % ROTATION.length];
      const { state } = drive({ seed, agents: scriptedTable({ seed, profile }), profile });
      endings.add(state.outcome!.reason);
      if (endings.size === 4) break;
    }
    expect([...endings].sort()).toEqual([
      "assassin_hit",
      "assassin_missed",
      "missions_evil",
      "rejection_limit",
    ]);
  });

  it("exercises both opening directions", () => {
    const directions = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const { state } = drive({ seed, profile: PROFILES.mixed });
      directions.add(state.playDirection!);
    }
    expect([...directions].sort()).toEqual(["left", "right"]);
  });

  it("exercises quests that succeed and quests that fail", () => {
    const results = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const { state } = drive({ seed, profile: PROFILES.mixed });
      for (const quest of state.log) {
        if (quest.type === "mission_result") results.add(quest.result);
      }
    }
    expect([...results].sort()).toEqual(["fail", "success"]);
  });

  it("exercises Lady holders who tell the truth and Lady holders who lie", () => {
    let truths = 0;
    let lies = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const { state } = drive({ seed, profile: PROFILES.mixed });
      for (const said of state.log) {
        if (said.type !== "lady_announced") continue;
        const truth = state.deal.evilSeats.includes(said.target) ? "evil" : "good";
        if (said.announced === truth) truths += 1;
        else lies += 1;
      }
    }
    expect(truths).toBeGreaterThan(0);
    expect(lies).toBeGreaterThan(0);
  });

  it("exercises evil passing a quest it could have failed", () => {
    // `passiveEvil` never plays the card, so every quest it rides comes back
    // clean — the branch that puts the game in the assassin's hands.
    let cleanWithVillainAboard = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const { state } = drive({
        seed,
        agents: scriptedTable({ seed, profile: PROFILES.passiveEvil }),
        profile: PROFILES.passiveEvil,
      });
      for (const quest of state.log) {
        if (quest.type !== "mission_result") continue;
        const villains = quest.team.filter((s) => state.deal.evilSeats.includes(s)).length;
        if (villains > 0 && quest.result === "success") cleanWithVillainAboard += 1;
      }
    }
    expect(cleanWithVillainAboard).toBeGreaterThan(0);
  });
});
