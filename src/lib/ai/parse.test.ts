import { describe, expect, it } from "vitest";
import { extractJson, parseAnalysis, parseSpeech } from "./parse";
import { readTone } from "./types";

/**
 * Every case here is something a model actually does. The point of the parser
 * is that none of them costs the user their turn at the table.
 */

describe("extractJson", () => {
  it("unwraps a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("unwraps a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("drops prose either side of the object", () => {
    expect(extractJson('好的，以下是分析：\n{"a":1}\n希望有帮助！')).toBe('{"a":1}');
  });

  it("leaves clean JSON alone", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseAnalysis", () => {
  const good = JSON.stringify({
    headline: "4号和6号最可疑",
    seats: [
      { seat: 4, read: "坏人", confidence: "high", why: "两趟崩车都在" },
      { seat: 2, read: "好人", confidence: "low", why: "票型干净" },
    ],
    keyPoints: ["盯住4号", "别让6号上车"],
    watchOut: "你已经有点像梅林了",
  });

  it("parses a well-formed response and sorts seats", () => {
    const result = parseAnalysis(good);
    expect(result.headline).toBe("4号和6号最可疑");
    expect(result.seats.map((s) => s.seat)).toEqual([2, 4]);
    expect(result.keyPoints).toHaveLength(2);
    expect(result.watchOut).toBe("你已经有点像梅林了");
  });

  it('accepts "3号" and "3" where a number was asked for', () => {
    const raw = JSON.stringify({
      headline: "x",
      seats: [
        { seat: "3号", read: "坏人", confidence: "高" },
        { seat: "5", read: "好人", confidence: "medium" },
      ],
      keyPoints: [],
    });
    expect(parseAnalysis(raw).seats.map((s) => s.seat)).toEqual([3, 5]);
  });

  it("normalises confidence written in Chinese or free-form", () => {
    const raw = JSON.stringify({
      headline: "x",
      seats: [
        { seat: 1, read: "坏人", confidence: "把握很大" },
        { seat: 2, read: "好人", confidence: "只是猜的" },
        { seat: 3, read: "不好说", confidence: "???" },
      ],
      keyPoints: [],
    });
    expect(parseAnalysis(raw).seats.map((s) => s.confidence)).toEqual([
      "high",
      "low",
      "medium",
    ]);
  });

  it("accepts keyPoints delivered as one newline-separated string", () => {
    const raw = JSON.stringify({
      headline: "x",
      seats: [],
      keyPoints: "- 盯住4号\n- 别让6号上车",
    });
    expect(parseAnalysis(raw).keyPoints).toEqual(["盯住4号", "别让6号上车"]);
  });

  it("survives a fenced response with prose around it", () => {
    expect(parseAnalysis("分析如下：\n```json\n" + good + "\n```").seats).toHaveLength(2);
  });

  it("skips rows with no usable seat rather than failing the whole response", () => {
    const raw = JSON.stringify({
      headline: "x",
      seats: [
        { seat: "不确定", read: "坏人" },
        { seat: 7, read: "好人" },
      ],
      keyPoints: [],
    });
    expect(parseAnalysis(raw).seats.map((s) => s.seat)).toEqual([7]);
  });

  it("throws on content that carries nothing at all", () => {
    expect(() => parseAnalysis("我无法分析这局游戏。")).toThrow();
    expect(() => parseAnalysis("")).toThrow();
    expect(() => parseAnalysis('{"seats":[],"keyPoints":[]}')).toThrow();
  });
});

describe("parseSpeech", () => {
  it("parses a well-formed outline", () => {
    const raw = JSON.stringify({
      stance: "稳一点，先站好人堆",
      outline: ["先复盘第2轮的车", "点名4号解释一下下票"],
      avoid: ["别说自己看到过谁"],
    });
    const result = parseSpeech(raw);
    expect(result.outline).toHaveLength(2);
    expect(result.avoid).toEqual(["别说自己看到过谁"]);
  });

  it("strips bullet glyphs the model added itself", () => {
    const raw = JSON.stringify({ stance: "x", outline: ["- 第一点", "• 第二点"] });
    expect(parseSpeech(raw).outline).toEqual(["第一点", "第二点"]);
  });

  it("omits avoid entirely when it comes back empty", () => {
    const raw = JSON.stringify({ stance: "x", outline: ["一点"], avoid: [] });
    expect(parseSpeech(raw).avoid).toBeUndefined();
  });

  it("throws when there are no outline points", () => {
    expect(() => parseSpeech('{"stance":"x","outline":[]}')).toThrow();
  });
});

describe("readTone", () => {
  it("puts the evil roles on the evil side, not the neutral one", () => {
    expect(readTone("莫甘娜")).toBe("evil");
    expect(readTone("刺客")).toBe("evil");
    expect(readTone("可能是坏人")).toBe("evil");
  });

  it("puts the good roles on the good side", () => {
    expect(readTone("梅林")).toBe("good");
    expect(readTone("派西维尔")).toBe("good");
    expect(readTone("好人")).toBe("good");
  });

  it("keeps 不好说 neutral and the user themselves separate", () => {
    expect(readTone("不好说")).toBe("neutral");
    expect(readTone("我自己")).toBe("self");
  });
});
