import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load";
import { observationFor } from "../core/observation";
import { MAX_STANDARD_INPUT_TOKENS } from "../core/input-limit";
import { drive, referenceDeal } from "../fixtures/harness";
import {
  ALL_TASK_IDS,
  capturePrompts,
  FIXED_PERSONA,
  FIXED_STRATEGY,
  promptFor,
} from "../fixtures/prompt-fixtures";
import { buildPlayerPrompt, guardPromptInput } from "./build";
import { PROMPT_VERSION } from "./version";
import { TRANSCRIPT_CLOSE, TRANSCRIPT_OPEN } from "./transcript";

/**
 * The prompt builder: stateless, Chinese, layered, and fed only an observation.
 */

function midGame(seed = 51) {
  const { state } = drive({
    seed,
    deal: referenceDeal(),
    stopWhen: (s) => s.missionTrack[0] !== "pending" && s.phase === "discussion",
  });
  return state;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("the seven layers", () => {
  it("are present, in order, once each", () => {
    const state = midGame();
    const prompt = promptFor(observationFor(state, state.pending!.seat));

    expect(prompt.layers.map((l) => l.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const marker of [
      "## 二、你的说话风格",
      "## 三、你的身份",
      "## 四、你实际看到的东西",
      "## 五、你现在的位置与场上局面",
      "## 六、策略档",
      "## 七、现在要你做的事",
    ]) {
      expect(count(prompt.fullText, marker)).toBe(1);
    }
  });

  it("splits static layers into the system message and moving ones into the user message", () => {
    const state = midGame();
    const prompt = promptFor(observationFor(state, state.pending!.seat));
    // 1-3 never change during a game; 4-7 do.
    expect(prompt.system).toContain("## 二、你的说话风格");
    expect(prompt.system).toContain("## 三、你的身份");
    expect(prompt.system).not.toContain("## 五、你现在的位置");
    expect(prompt.user).toContain("## 四、你实际看到的东西");
    expect(prompt.user).toContain("## 七、现在要你做的事");
    expect(prompt.fullText).toBe(`${prompt.system}\n\n${prompt.user}`);
  });

  it("is written in Chinese", () => {
    const { prompts } = capturePrompts();
    for (const prompt of prompts.values()) {
      const cjk = (prompt.fullText.match(/[一-鿿]/g) ?? []).length;
      expect(cjk).toBeGreaterThan(1000);
      // No English prose headings leaked in from the code.
      expect(prompt.fullText).not.toMatch(/^##\s+[A-Za-z]/m);
    }
  });

  it("stamps the prompt version, and it matches the recorded one", () => {
    const state = midGame();
    const prompt = promptFor(observationFor(state, state.pending!.seat));
    expect(prompt.promptVersion).toBe(PROMPT_VERSION);
    // The version in the config is what lands in a trace; if the two drifted, a
    // trace would name a prompt that never produced it.
    expect(loadConfig().promptVersion).toBe(PROMPT_VERSION);
  });
});

describe("the public history appears exactly once", () => {
  it("has one transcript block", () => {
    const { prompts } = capturePrompts();
    for (const prompt of prompts.values()) {
      expect(count(prompt.fullText, TRANSCRIPT_OPEN)).toBe(1);
      expect(count(prompt.fullText, TRANSCRIPT_CLOSE)).toBe(1);
    }
  });

  /**
   * The sharp version. Every event line is prefixed `[#sequence]`, so if any
   * layer re-serialised the history — a summary, a "recent events" recap, a
   * second copy in the task block — a marker would appear twice.
   */
  it("mentions each event's sequence marker exactly once", () => {
    const { prompts } = capturePrompts();
    for (const [taskId, prompt] of prompts) {
      const observation = prompt.layers[4];
      void observation;
      const markers = prompt.fullText.match(/\[#\d+\]/g) ?? [];
      expect(new Set(markers).size, `${taskId} repeated a marker`).toBe(markers.length);
    }
  });

  it("keeps a SINGLE request bounded by the current history", () => {
    // Precisely: this is about ONE request, not about a game's total.
    //
    // Per-request input grows with the history the request carries, and
    // cumulative input across a game is roughly QUADRATIC in the turn count
    // because request k carries about k events. Statelessness does not change
    // that. What it avoids is a chat thread ALSO accumulating every earlier
    // observation snapshot, which would be a second growth term on top.
    const { state } = drive({
      seed: 52,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "discussion" && s.log.length > 4,
    });
    const early = promptFor(observationFor(state, state.pending!.seat)).fullText.length;

    const { state: later } = drive({
      seed: 52,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "discussion" && s.log.length > 60,
    });
    const late = promptFor(observationFor(later, later.pending!.seat)).fullText.length;

    expect(late).toBeGreaterThan(early);
    // Fifteen times the events does not mean fifteen times the request: the
    // fixed layers dominate and the transcript is carried exactly once. That
    // is a statement about one request, and nothing more.
    expect(late).toBeLessThan(early * 4);
  });
});

describe("what the builder may be given", () => {
  it("refuses anything carrying referee state", () => {
    const state = midGame();
    const observation = observationFor(state, state.pending!.seat);
    const poisoned = { ...observation, deal: state.deal } as unknown as typeof observation;
    expect(() =>
      buildPlayerPrompt({
        observation: poisoned,
        persona: FIXED_PERSONA,
        strategy: FIXED_STRATEGY,
      }),
    ).toThrow(/referee state/);
  });

  it("refuses each referee-only key by name", () => {
    const state = midGame();
    const observation = observationFor(state, state.pending!.seat);
    for (const key of ["bySeat", "pendingVotes", "missionCards", "privateLog"]) {
      const poisoned = { ...observation, [key]: {} } as unknown as typeof observation;
      expect(() =>
        buildPlayerPrompt({
          observation: poisoned,
          persona: FIXED_PERSONA,
          strategy: FIXED_STRATEGY,
        }),
      ).toThrow(new RegExp(key));
    }
  });

  it("refuses a seat that is not being asked anything", () => {
    const state = midGame();
    const idle = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find(
      (s) => s !== state.pending!.seat,
    ) as 1;
    expect(() =>
      buildPlayerPrompt({
        observation: observationFor(state, idle),
        persona: FIXED_PERSONA,
        strategy: FIXED_STRATEGY,
      }),
    ).toThrow(/no pending request/);
  });
});

describe("every decision kind has a schema", () => {
  it("covers all ten", () => {
    const { prompts } = capturePrompts();
    expect([...prompts.keys()].sort()).toEqual([...ALL_TASK_IDS].sort());
  });

  it("separates public message, action, memory and rationale", () => {
    const { prompts } = capturePrompts();
    for (const [taskId, prompt] of prompts) {
      const groups = new Set(prompt.schema.fields.map((f) => f.group));
      expect(groups.has("memory"), taskId).toBe(true);
      expect(groups.has("rationale"), taskId).toBe(true);
      // Every task either says something out loud or executes something.
      expect(groups.has("public") || groups.has("action"), taskId).toBe(true);
      expect(prompt.fullText).toContain("私有记忆（只有你以后看得到）");
      expect(prompt.fullText).toContain("理由（给研究者看的注解，不是思维链）");
    }
  });

  it("never asks for hidden reasoning", () => {
    const { prompts } = capturePrompts();
    for (const prompt of prompts.values()) {
      expect(prompt.fullText).toContain("不要写你的完整推理过程");
      expect(prompt.fullText).toContain("不是思维链");
      for (const phrase of ["一步一步思考", "先思考再回答", "写出你的推理过程", "chain of thought"]) {
        expect(prompt.fullText).not.toContain(phrase);
      }
    }
  });

  it("restates the speech budget wherever something is said out loud", () => {
    // `evil_discuss` speaks too — to three listeners rather than ten — and
    // carries the same budget, so the check keys off the schema's own limit
    // rather than off a field name.
    const spoken = new Set(["publicMessage", "message"]);
    const { prompts } = capturePrompts();
    for (const [taskId, prompt] of prompts) {
      const says = prompt.schema.fields.some((f) => spoken.has(f.name));
      if (!says) {
        expect(prompt.schema.publicMessageLimit, taskId).toBeNull();
        continue;
      }
      expect(prompt.schema.publicMessageLimit, taskId).toBe(220);
      expect(prompt.fullText).toContain("最多 220 个非空白字符");
    }
  });

  it("tells the leader that closing and proposing are one answer", () => {
    const { prompts } = capturePrompts();
    const close = prompts.get("leader-close-and-propose")!;
    expect(close.fullText).toContain("这一次回答同时包含两件事");
    expect(close.schema.fields.some((f) => f.name === "publicMessage")).toBe(true);
    expect(close.schema.fields.some((f) => f.name === "team")).toBe(true);
  });
});

describe("the input ceiling", () => {
  it("is wired to a caller-supplied count and defaults to the contract", () => {
    expect(guardPromptInput(MAX_STANDARD_INPUT_TOKENS).ok).toBe(true);
    expect(guardPromptInput(MAX_STANDARD_INPUT_TOKENS + 1).ok).toBe(false);
  });

  it("honours a lower configured limit", () => {
    const config = loadConfig({ limits: { maxStandardInputTokens: 1000 } });
    expect(guardPromptInput(1000, config).ok).toBe(true);
    expect(guardPromptInput(1001, config).ok).toBe(false);
  });

  it("bundles no tokeniser and guesses no count", () => {
    // Deliberate: the count arrives with the model client, once the supported
    // counting mechanism for the configured model has been verified. A guessed
    // tokeniser that undercounts would leave the gate green while oversized
    // requests went out.
    const state = midGame();
    const prompt = promptFor(observationFor(state, state.pending!.seat));
    expect(Object.keys(prompt)).not.toContain("tokens");
    expect(Object.keys(prompt)).not.toContain("inputTokens");
  });
});
