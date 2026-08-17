import { describe, expect, it } from "vitest";
import { binaryEntropy, explainCheck, rankChecks } from "./information";
import type { Hypothesis } from "./types";

/** Builds a world where exactly `evil` are the evil seats. */
function world(...evil: string[]): Hypothesis {
  const set = new Set(evil);
  return { evil, isEvil: (id: string) => set.has(id) };
}

describe("binaryEntropy", () => {
  it("是零当结论已经确定", () => {
    expect(binaryEntropy(0)).toBe(0);
    expect(binaryEntropy(1)).toBe(0);
  });

  it("在五五开时取到最大值 1 bit", () => {
    expect(binaryEntropy(0.5)).toBeCloseTo(1, 12);
  });

  it("对称：0.2 和 0.8 一样有信息量", () => {
    expect(binaryEntropy(0.2)).toBeCloseTo(binaryEntropy(0.8), 12);
  });

  it("越接近确定，值越小", () => {
    expect(binaryEntropy(0.5)).toBeGreaterThan(binaryEntropy(0.7));
    expect(binaryEntropy(0.7)).toBeGreaterThan(binaryEntropy(0.9));
  });
});

describe("rankChecks", () => {
  it("空输入不炸", () => {
    expect(rankChecks([], [], ["a"])).toEqual([]);
    expect(rankChecks([world("a")], [1], [])).toEqual([]);
  });

  it("没有权重时按世界数均分", () => {
    // a 在 2/4 个世界里是坏人，b 在 1/4。
    const worlds = [world("a"), world("a"), world("b"), world("c")];
    const [first] = rankChecks(worlds, [], ["a"]);
    expect(first.pEvil).toBeCloseTo(0.5, 12);
  });

  it("权重生效", () => {
    const worlds = [world("a"), world("b")];
    const [value] = rankChecks(worlds, [0.9, 0.1], ["a"]);
    expect(value.pEvil).toBeCloseTo(0.9, 12);
  });

  /**
   * 这条是整个模块存在的理由：最该验的不是最可疑的那个。
   */
  it("最拿不准的排在最怀疑的前面", () => {
    // a 在 9/10 个世界里是坏人（很确定）；b 在 5/10（完全拿不准）。
    const worlds = [
      ...Array.from({ length: 5 }, () => world("a", "b")),
      ...Array.from({ length: 4 }, () => world("a", "c")),
      world("d", "c"),
    ];
    const ranked = rankChecks(worlds, [], ["a", "b"]);

    expect(ranked[0].playerId).toBe("b");
    expect(ranked[0].pEvil).toBeCloseTo(0.5, 12);
    expect(ranked[1].playerId).toBe("a");
    expect(ranked[1].pEvil).toBeCloseTo(0.9, 12);
    // 而且高度可疑的那个几乎不值得验。
    expect(ranked[1].bits).toBeLessThan(0.5);
  });

  it("已经被证明的座位一点信息都不剩", () => {
    const worlds = [world("a", "b"), world("a", "c")];
    const [proven] = rankChecks(worlds, [], ["a"]);
    expect(proven.pEvil).toBe(1);
    expect(proven.bits).toBe(0);
  });

  it("一个 bit 是上限 —— 是非题问不出更多", () => {
    const worlds = [world("a"), world("b")];
    for (const value of rankChecks(worlds, [], ["a", "b"])) {
      expect(value.bits).toBeLessThanOrEqual(1);
    }
  });

  it("平手时保持传入顺序，结果可复现", () => {
    const worlds = [world("a", "b"), world("c", "d")];
    const ranked = rankChecks(worlds, [], ["a", "b", "c", "d"]);
    expect(ranked.map((v) => v.playerId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("explainCheck", () => {
  it("对已经确定的两个方向说法不同", () => {
    expect(explainCheck({ playerId: "x", pEvil: 0.98, bits: 0.14 })).toContain(
      "坏人",
    );
    expect(explainCheck({ playerId: "x", pEvil: 0.02, bits: 0.14 })).toContain(
      "好人",
    );
  });

  it("五五开时说收获最大", () => {
    expect(explainCheck({ playerId: "x", pEvil: 0.5, bits: 1 })).toContain(
      "收获最大",
    );
  });
});
