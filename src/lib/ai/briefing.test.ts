import { describe, expect, it } from "vitest";
import { buildBriefing } from "./briefing";
import { game, approveOnly } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";

/**
 * These tests guard the distinctions the data model works hardest to preserve.
 * Every one of them is a place where a lazy renderer would flatten two
 * different facts into one line and hand the model a confident lie.
 */

describe("buildBriefing", () => {
  it("renders a real game without throwing, and covers every section", () => {
    const { game: g, events } = ninePlayerGame();
    const text = buildBriefing(g, events);

    expect(text).toContain("## 牌局");
    expect(text).toContain("## 五轮任务");
    expect(text).toContain("## 每一辆车和票型");
    expect(text).toContain("## 公开保踩");
    expect(text).toContain("## 我记的零散备注");
    expect(text).toContain("9 人局");
  });

  it("keeps 没表过态 and 明确中立 apart", () => {
    // 7号 explicitly said 中立(3) about 2号; 8号 never said anything at all.
    const { game: g, events } = ninePlayerGame();
    const text = buildBriefing(g, events);

    expect(text).toContain("2号=3(中立)");
    expect(text).toMatch(/没对任何人公开表过态[^\n]*8号/);
  });

  it("renders the whole chain when someone changed their mind", () => {
    const { game: g, events } = game(9)
      .opinion(3, 6, 4)
      .opinion(3, 6, 5)
      .opinion(3, 6, 2)
      .build();

    expect(buildBriefing(g, events)).toContain("[改过口：4→5→2]");
  });

  it("separates 意向车 from the car actually proposed", () => {
    const { game: g, events } = game(9)
      .intendedTeam(4, [1, 3, 5])
      .proposal(4, [2, 4, 6])
      .build();
    const text = buildBriefing(g, events);

    expect(text).toContain("4号 嘴上说会带 1号·3号·5号");
    expect(text).toContain("4号 带 2号·4号·6号");
  });

  it("distinguishes a seat recorded as unknown from one never recorded", () => {
    const { game: g, events } = game(5)
      .proposal(1, [1, 2])
      .vote({ 1: "approve", 2: "reject", 3: "unknown" }, "rejected")
      .build();
    const text = buildBriefing(g, events);

    expect(text).toContain("没看清 3号");
    expect(text).toContain("没记下来 4号·5号");
  });

  it("labels vision as certain and guesses as fallible", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(8, { kind: "role", role: "morgana" }, "guess")
      .build();
    const text = buildBriefing(g, events);

    expect(text).toContain("我的视野");
    expect(text).toContain("4号 是 坏人");
    expect(text).toContain("我自己之前的推测");
    expect(text).toContain("8号 是 莫甘娜");
  });

  it("drops the entire private layer when asked to", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .build();
    const text = buildBriefing(g, events, { includePrivate: false });

    expect(text).not.toContain("我的视野");
    expect(text).not.toContain("我自己（私密信息");
    expect(text).not.toContain("4号 是 坏人");
  });

  it("reports the announcement of a lady check, never a truth", () => {
    const { game: g, events } = game(9)
      .lady()
      .ladyTo(2)
      .ladyCheck(2, 5, "good")
      .build();
    const text = buildBriefing(g, events);

    expect(text).toContain("2号 验了 5号，当众说他是好人");
    expect(text).toContain("说的话不一定是真的");
  });

  it("warns when the rejection streak is close to handing evil the win", () => {
    const b = game(5).firstLeader(1);
    for (let i = 0; i < 3; i++) {
      b.proposal(1, [1, 2]).vote(approveOnly(5, [1]), "rejected");
    }
    const { game: g, events } = b.build();

    expect(buildBriefing(g, events)).toContain("连续否了 3 辆车");
  });

  it("is stable: the same log renders identically twice", () => {
    const { game: g, events } = ninePlayerGame();
    expect(buildBriefing(g, events)).toBe(buildBriefing(g, events));
  });
});
