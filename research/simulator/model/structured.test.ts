import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "../core/types";
import { extractJson, parseAction } from "./structured";

/**
 * The malformed-output table.
 *
 * Strict structured output stops most of this at the provider. This layer
 * exists for the rest, and every row below is something a model has actually
 * been observed doing: fencing the JSON, apologising first, writing 「3号」
 * where a number was asked for, returning an empty string when a filter fires.
 *
 * The dividing line is deliberate. SHAPE problems are repaired here, because
 * losing a turn to a stray code fence would be absurd. RULE problems are NOT
 * touched — team size, Lady eligibility, whether a villain may fail a quest —
 * because the referee already checks those without mutating anything, and a
 * second copy of the rulebook is the first thing to drift.
 */

const speech: DecisionRequest = { kind: "speech", seat: 3, slot: "regular" };
const vote: DecisionRequest = { kind: "vote", seat: 3 };
const close: DecisionRequest = { kind: "leader_close_and_propose", seat: 3, teamSize: 3 };
const lady: DecisionRequest = { kind: "lady_select", seat: 3, eligible: [5, 6, 7] };

describe("extracting the JSON", () => {
  it("takes it plain", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("strips a fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips prose either side", () => {
    expect(extractJson('好的，以下是我的回答：\n{"a":1}\n希望有帮助。')).toBe('{"a":1}');
  });

  it("returns nothing usable when there is nothing usable", () => {
    expect(extractJson("")).toBe("");
    expect(extractJson("我不能回答这个问题。")).toBe("我不能回答这个问题。");
  });
});

describe("recoverable shape problems", () => {
  it("accepts a fenced answer", () => {
    const result = parseAction('```json\n{"choice":"approve"}\n```', vote);
    expect(result).toEqual({ ok: true, action: { kind: "vote", choice: "approve" } });
  });

  it("accepts prose around the JSON", () => {
    const result = parseAction('我投上票。\n{"choice": "approve"}\n以上。', vote);
    expect(result.ok).toBe(true);
  });

  it('reads "3号" as seat 3', () => {
    const result = parseAction('{"target":"5号"}', lady);
    expect(result).toEqual({ ok: true, action: { kind: "lady_select", target: 5 } });
  });

  it("reads a seat list written as strings", () => {
    const result = parseAction('{"publicMessage":"x","team":["1号","4","7"]}', close);
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({ team: [1, 4, 7] });
  });

  it("tolerates case and padding in an enum", () => {
    expect(parseAction('{"choice":" Approve "}', vote).ok).toBe(true);
  });

  it("drops a stance a seat aimed at itself", () => {
    // The referee would refuse the whole speech; losing it over one stray row
    // is a worse trade than losing the row.
    const result = parseAction(
      '{"publicMessage":"x","stances":[{"seat":3,"valence":1,"confidence":1},{"seat":4,"valence":-1,"confidence":0.5}]}',
      speech,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({ stances: [{ seat: 4, valence: -1 }] });
  });

  it("clamps an out-of-range number instead of failing", () => {
    const result = parseAction(
      '{"publicMessage":"x","stances":[{"seat":4,"valence":-9,"confidence":42}]}',
      speech,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({ stances: [{ seat: 4, valence: -1, confidence: 1 }] });
  });

  it("supplies a default confidence when only a valence came back", () => {
    const result = parseAction(
      '{"publicMessage":"x","stances":[{"seat":4,"valence":-0.5}]}',
      speech,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({ stances: [{ seat: 4, confidence: 0.5 }] });
  });

  it("ignores fields nobody asked for", () => {
    const result = parseAction('{"choice":"reject","thinking":"…","extra":[1,2]}', vote);
    expect(result).toEqual({ ok: true, action: { kind: "vote", choice: "reject" } });
  });

  it("carries the memory patch and the rationale through", () => {
    const result = parseAction(
      '{"choice":"approve","memoryPatch":{"beliefs":[{"seat":6,"pEvil":0.8,"note":"票不对"}],"intentions":["看第四轮"],"commitments":null},"rationale":"车干净"}',
      vote,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({
      memoryPatch: {
        beliefs: [{ seat: 6, pEvil: 0.8, note: "票不对" }],
        intentions: ["看第四轮"],
      },
    });
  });

  it("treats null and absent optional fields the same way", () => {
    // Strict mode requires every property, so "optional" arrives as null.
    const withNulls = parseAction(
      '{"publicMessage":"x","tentativeTeam":null,"noTeamYet":null,"stances":null,"claim":null,"memoryPatch":null,"rationale":null}',
      speech,
    );
    const withNone = parseAction('{"publicMessage":"x"}', speech);
    expect(withNulls).toEqual(withNone);
  });
});

describe("unrecoverable payloads", () => {
  const cases: readonly { name: string; raw: string; request: DecisionRequest }[] = [
    { name: "empty string", raw: "", request: vote },
    { name: "whitespace", raw: "   \n  ", request: vote },
    { name: "a refusal", raw: "抱歉，我不能参与这个游戏。", request: vote },
    { name: "broken JSON", raw: '{"choice": "approve"', request: vote },
    { name: "an array", raw: '["approve"]', request: vote },
    { name: "a bare string", raw: '"approve"', request: vote },
    { name: "the wrong enum", raw: '{"choice":"maybe"}', request: vote },
    { name: "a missing required field", raw: '{"rationale":"…"}', request: vote },
    { name: "a missing message", raw: '{"team":[1,2,3]}', request: close },
    { name: "a missing team", raw: '{"publicMessage":"x"}', request: close },
    { name: "a seat out of range", raw: '{"target":42}', request: lady },
    { name: "a non-seat in a team", raw: '{"publicMessage":"x","team":[1,"甲",3]}', request: close },
  ];

  for (const { name, raw, request } of cases) {
    it(`rejects ${name}`, () => {
      const result = parseAction(raw, request);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.length).toBeGreaterThan(0);
    });
  }

  it("says something a model could act on", () => {
    const result = parseAction('{"choice":"maybe"}', vote);
    if (result.ok) throw new Error("unreachable");
    // The message is fed straight back into the retry, so it has to name the
    // field and the allowed values rather than say "invalid".
    expect(result.error).toContain("choice");
    expect(result.error).toContain("approve");
  });
});

describe("rule checking is left to the referee", () => {
  it("parses a team of the wrong size without complaint", () => {
    // The referee rejects this, without mutating anything, and its message is
    // what gets handed back. Duplicating the check here would be a second
    // rulebook to keep in step.
    const result = parseAction('{"publicMessage":"x","team":[1,2]}', close);
    expect(result.ok).toBe(true);
  });

  it("parses an ineligible Lady target without complaint", () => {
    const result = parseAction('{"target":9}', lady);
    expect(result).toEqual({ ok: true, action: { kind: "lady_select", target: 9 } });
    expect(lady.kind === "lady_select" && lady.eligible).not.toContain(9);
  });

  it("parses a contradictory speech without resolving it", () => {
    // Both a tentative team and "I cannot form one" — the referee refuses it,
    // and hiding the contradiction here would conceal a model that did not
    // read the instruction.
    const result = parseAction(
      '{"publicMessage":"x","tentativeTeam":[1,2,3],"noTeamYet":true}',
      speech,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.action).toMatchObject({ noTeamYet: true, tentativeTeam: [1, 2, 3] });
  });
});
