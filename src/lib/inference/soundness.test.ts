import { describe, expect, it } from "vitest";
import { deriveSideInference } from "./side";
import { game as makeGame, type GameBuilder } from "@/lib/fixtures/builder";
import { requiredFails, evilCount, teamSize } from "@/lib/rules/avalon";
import type { PlayerCount, VoteChoice } from "@/lib/types/game";

/**
 * SOUNDNESS: the truth must never be ruled out.
 *
 * The hard layer makes claims of IMPOSSIBILITY, and the UI prints them as
 * 「排除了」. Every other property of this module is a nice-to-have; this one is
 * load-bearing. A single false elimination — telling a user a seat cannot be
 * evil when it is — would discredit the whole feature, and it would do so
 * silently, because from the user's side a wrong exclusion looks exactly like
 * a right one.
 *
 * So rather than hand-writing cases, this generates thousands of games from a
 * known ground truth and asserts the invariant after every single event:
 *
 *     the real evil set is always among the surviving hypotheses
 *
 * This is the local, zero-dependency form of validating against the 12,699-game
 * AvalonLogs corpus. That corpus is strictly better — real humans, real
 * distributions — but this needs no download, runs in the normal suite, and
 * tests the same invariant: a rule-derived elimination is either sound for
 * every game ever played, or it is a bug.
 *
 * Note the generator plays DELIBERATELY BADLY on purpose — evil sometimes
 * withholds fail cards, good players vote randomly, records go missing. A
 * generator that only produced sensible games would exercise only the cases
 * the implementation was written with in mind.
 */

/** Deterministic PRNG so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Choose `k` distinct seats from 1..n. */
function sample(random: () => number, n: number, k: number): number[] {
  const seats = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return seats.slice(0, k).sort((a, b) => a - b);
}

interface Generated {
  builder: GameBuilder;
  /** Ground truth, by seat. */
  evilSeats: number[];
  playerCount: PlayerCount;
}

/**
 * A full game played out from a known truth, recorded the way a distracted
 * human would: some votes missed, some fail counts never counted.
 */
function generate(seed: number): Generated {
  const random = rng(seed);
  const playerCount = pick(random, [5, 6, 7, 8, 9, 10] as const);
  const evils = evilCount(playerCount);
  const evilSeats = sample(random, playerCount, evils);
  const isEvil = (seat: number) => evilSeats.includes(seat);

  const builder = makeGame(playerCount);
  let leader = 1;

  for (let mission = 1; mission <= 5; mission++) {
    const size = teamSize(playerCount, mission);
    // Rejections happen; sometimes several in a row.
    const attempts = 1 + Math.floor(random() * 3);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const team = sample(random, playerCount, size);
      builder.proposal(leader, team);
      leader = (leader % playerCount) + 1;

      const votes: Record<number, VoteChoice> = {};
      for (let seat = 1; seat <= playerCount; seat++) {
        const roll = random();
        // 15% of seats go unrecorded entirely, and some are noted as unclear —
        // the two states this app insists on keeping distinct.
        if (roll < 0.15) continue;
        if (roll < 0.22) {
          votes[seat] = "unknown";
          continue;
        }
        votes[seat] = random() < 0.5 ? "approve" : "reject";
      }

      const passed = attempt === attempts;
      builder.vote(votes, passed ? "passed" : "rejected");

      if (!passed) continue;

      // Each evil aboard independently decides whether to play the fail card —
      // including choosing not to, which is what makes a naive "team failed so
      // everyone aboard is evil" rule unsound.
      const aboard = team.filter(isEvil);
      let fails = 0;
      for (let i = 0; i < aboard.length; i++) if (random() < 0.6) fails += 1;
      const needed = requiredFails(playerCount, mission);
      const result = fails >= needed ? "fail" : "success";
      // Half the time the user never counted the cards.
      if (random() < 0.5) builder.mission(result, fails);
      else builder.mission(result);
    }
  }

  return { builder, evilSeats, playerCount };
}

describe("the truth is never eliminated", () => {
  // 400 games scored after every event, so it is inherently slow — and it got
  // slower when the proposal term was added to the likelihood. The 5s default
  // is a limit on the harness, not on this property; the check itself is
  // deterministic and must never be weakened to fit inside it.
  it("survives 400 generated games, checked after every event", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { builder, evilSeats } = generate(seed);
      const { game: g, events } = builder.build();
      const truth = evilSeats.map((s) => `p${s}`).sort().join(",");

      // Re-derive at every prefix: time travel is free, and a false
      // elimination that only appears mid-game is still a false elimination.
      for (let cut = 0; cut <= events.length; cut++) {
        const side = deriveSideInference(events.slice(0, cut), g);
        const found = side.surviving.some(
          (h) => [...h.evil].sort().join(",") === truth,
        );
        expect(
          found,
          `seed ${seed}, after ${cut} events: real evils ${truth} were ruled out`,
        ).toBe(true);
      }
    }
  }, 30_000);

  it("survives games where the user's own vision is recorded", () => {
    // Vision is the strongest constraint and therefore the easiest to get
    // wrong — it must narrow hard without ever excluding the truth.
    for (let seed = 500; seed <= 700; seed++) {
      const { builder, evilSeats, playerCount } = generate(seed);
      const random = rng(seed * 7);

      // Cast the user as an evil player who can see their teammates.
      const me = evilSeats[0];
      for (const seat of evilSeats) {
        if (seat !== me) builder.mark(seat, { kind: "side", side: "evil" }, "known");
      }
      const { game: base, events } = builder.build();
      const g = {
        ...base,
        viewerPlayerId: `p${me}`,
        viewerRole: pick(random, ["assassin", "morgana", "minion"] as const),
      };

      const truth = evilSeats.map((s) => `p${s}`).sort().join(",");
      const side = deriveSideInference(events, g);
      expect(
        side.surviving.some((h) => [...h.evil].sort().join(",") === truth),
        `seed ${seed} (${playerCount}p): vision ruled out the truth`,
      ).toBe(true);
      // And it should have narrowed a great deal — knowing your own team is
      // nearly the whole answer.
      expect(side.surviving.length).toBeLessThanOrEqual(
        playerCount - evilSeats.length + 1,
      );
    }
  });

  it("never contradicts itself on a well-formed log", () => {
    // Contradiction is legitimate for a mistyped record, but a game generated
    // from a consistent truth must never produce one.
    for (let seed = 800; seed <= 1000; seed++) {
      const { builder } = generate(seed);
      const { game: g, events } = builder.build();
      const side = deriveSideInference(events, g);
      expect(side.contradictory, `seed ${seed}`).toBe(false);
      expect(side.surviving.length).toBeGreaterThan(0);
    }
  });

  it("keeps proven claims true against the ground truth", () => {
    // The strongest claim the layer makes. If it says 「确定是坏人」, it had
    // better be.
    for (let seed = 1100; seed <= 1400; seed++) {
      const { builder, evilSeats } = generate(seed);
      const { game: g, events } = builder.build();
      const side = deriveSideInference(events, g);

      for (const playerId of side.provenEvil) {
        const seat = Number(playerId.slice(1));
        expect(evilSeats, `seed ${seed}: ${playerId} proven evil`).toContain(seat);
      }
      for (const playerId of side.provenGood) {
        const seat = Number(playerId.slice(1));
        expect(evilSeats, `seed ${seed}: ${playerId} proven good`).not.toContain(
          seat,
        );
      }
    }
  });
});
