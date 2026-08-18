import { describe, expect, it } from "vitest";
import { inferenceFocus } from "./focus";
import { game } from "@/lib/fixtures/builder";
import type { GameRecord, RoleType } from "@/lib/types/game";

function nineAs(role: RoleType | undefined, build = (b: ReturnType<typeof game>) => b) {
  const { game: g, events } = build(game(9)).build();
  const withRole: GameRecord = { ...g, viewerPlayerId: "p1", viewerRole: role };
  return { game: withRole, events };
}

const labels = (items: ReturnType<typeof inferenceFocus>) =>
  items.map((i) => i.role ?? i.kind);

describe("每个身份问的是不同的问题", () => {
  it("梅林不问谁是坏人 —— 他已经看到了", () => {
    const { game: g, events } = nineAs("merlin");
    const focus = inferenceFocus(events, g);

    expect(labels(focus)).not.toContain("sides");
    // 9 人局有莫德雷德，那是他唯一看不见的坏人
    expect(labels(focus)).toContain("mordred");
    expect(labels(focus)[0]).toBe("percival");
  });

  it("忠臣先问阵营，再问梅林", () => {
    const { game: g, events } = nineAs("loyal");
    expect(labels(inferenceFocus(events, g))).toEqual(["sides", "merlin"]);
  });

  it("坏人第一位永远是找梅林", () => {
    for (const role of ["morgana", "mordred", "assassin", "minion"] as const) {
      const { game: g, events } = nineAs(role);
      expect(labels(inferenceFocus(events, g))[0]).toBe("merlin");
    }
  });

  it("刺客被明确告知这一刀由他来捅", () => {
    const { game: g, events } = nineAs("assassin");
    expect(inferenceFocus(events, g)[0].why).toContain("局末你要动手");
  });

  it("派西维尔要分辨他看到的那两个人", () => {
    const { game: g, events } = nineAs("percival");
    expect(labels(inferenceFocus(events, g)).slice(0, 2)).toEqual([
      "merlin",
      "morgana",
    ]);
  });

  it("奥伯伦被提醒他连队友都不认识", () => {
    const { game: g, events } = nineAs("oberon");
    const why = inferenceFocus(events, g).map((i) => i.why).join(" ");
    expect(why).toContain("队友不认得你");
  });
});

describe("场上没有的角色不会被问起", () => {
  it("没有莫德雷德的局，不会让梅林去找莫德雷德", () => {
    const { game: g, events } = game(9).build();
    const noMordred: GameRecord = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
      roleSet: {
        rolesIncluded: ["merlin", "percival", "loyal", "morgana", "assassin"],
      },
    };
    expect(labels(inferenceFocus(events, noMordred))).not.toContain("mordred");
  });
});

describe("跳派的人多了，问题就变了", () => {
  it("两个人跳派时，把问题改写成「谁是真派」", () => {
    const { game: g, events } = nineAs("assassin", (b) => b.claim(3).claim(7));
    const percival = inferenceFocus(events, g).find((i) => i.role === "percival")!;

    expect(percival.label).toContain("2 个人跳了");
    expect(percival.why).toContain("至少一个在骗人");
  });

  it("只有一个人跳派时不这么说", () => {
    const { game: g, events } = nineAs("assassin", (b) => b.claim(3));
    const percival = inferenceFocus(events, g).find((i) => i.role === "percival")!;
    expect(percival.label).not.toContain("跳了");
  });
});

describe("没填身份", () => {
  it("不替用户编一个立场出来", () => {
    const { game: g, events } = nineAs(undefined);
    expect(inferenceFocus(events, g)).toEqual([]);
  });
});
