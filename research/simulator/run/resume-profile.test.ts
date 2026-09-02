import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_NAMES, loadProfile, resolveProfileForResume } from "../config/load";

/**
 * The resume path never guesses which experiment arm it is continuing.
 *
 * THE DEFECT THIS FIXES IS REAL AND RECENT. Resuming the completed M5.2 pilot
 * without `--profile` fell back to `default.json` — `prompt-0.2.0`, the
 * `baseline` strategy, a different output ceiling. Nothing was damaged, and
 * only by luck: the checkpoint was cognitive, so `resumeFromCheckpoint` refused
 * on `prompt_version_mismatch` before a single request left. A `prompt-0.2.0`
 * checkpoint resumed the same way would have passed every gate, and half a game
 * would have continued under an arm nobody chose.
 *
 * The fix is not "warn louder". It is that the fallback no longer exists on a
 * resume: the profile is either recorded in the checkpoint or the operator
 * states it, and a checkpoint too old to record one is REFUSED rather than
 * assumed to be default.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("resume tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("新开一局：行为完全不变", () => {
  it("不给 --profile 就是 default.json，和这个标志存在之前一样", () => {
    const r = resolveProfileForResume({ flag: null, checkpoint: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile).toBeNull();
      expect(r.derived).toBe(false);
    }
  });

  it("给了就是那个 profile", () => {
    const r = resolveProfileForResume({ flag: "m5-3-terra-pilot", checkpoint: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("m5-3-terra-pilot");
  });
});

describe("续跑：从检查点推导，或者拒绝", () => {
  it("检查点记了 profile，不给标志也能续 —— 而且是推导出来的", () => {
    const r = resolveProfileForResume({
      flag: null,
      checkpoint: { profile: "m5-3-terra-pilot" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile).toBe("m5-3-terra-pilot");
      // `derived` is what makes the CLI say so out loud instead of silently
      // continuing under something the operator did not type.
      expect(r.derived).toBe(true);
    }
  });

  it("**旧检查点（没记 profile）+ 不给标志 → 拒绝，不退回 default.json**", () => {
    // This is the exact situation that nearly ruined the M5.2 resume.
    const r = resolveProfileForResume({ flag: null, checkpoint: { profile: null } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("拒绝续跑");
      expect(r.error).toContain("default.json");
      // It names the flag and the legal values, so the operator does not have
      // to go and read the source to recover.
      expect(r.error).toContain("--profile");
      for (const name of PROFILE_NAMES) expect(r.error).toContain(name);
    }
  });

  it("旧检查点确实是 default.json 跑的时候，要显式说出来才放行", () => {
    const r = resolveProfileForResume({
      flag: null,
      checkpoint: { profile: null },
      allowDefault: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile).toBeNull();
      // Not "derived": somebody typed it.
      expect(r.derived).toBe(false);
    }
  });

  it("标志和检查点对不上 → 拒绝，并说清两边分别是什么", () => {
    const r = resolveProfileForResume({
      flag: "m5-3-luna-pilot",
      checkpoint: { profile: "m5-3-terra-pilot" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("m5-3-terra-pilot");
      expect(r.error).toContain("m5-3-luna-pilot");
      expect(r.error).toContain("不能拆成两个 profile");
    }
  });

  it("配对实验里这条尤其重要：Terra 的检查点不能用 Luna 续", () => {
    // Half a game on each model is a game belonging to neither arm — and the
    // per-stage model is the ONLY thing the two arms differ in, so nothing
    // else downstream would notice.
    const terra = loadProfile("m5-3-terra-pilot");
    const luna = loadProfile("m5-3-luna-pilot");
    expect(terra.model.id).not.toBe(luna.model.id);
    const r = resolveProfileForResume({
      flag: "m5-3-terra-pilot",
      checkpoint: { profile: "m5-3-luna-pilot" },
    });
    expect(r.ok).toBe(false);
  });

  it("标志和检查点一致 → 放行", () => {
    const r = resolveProfileForResume({
      flag: "m5-3-luna-pilot",
      checkpoint: { profile: "m5-3-luna-pilot" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile).toBe("m5-3-luna-pilot");
  });

  it("检查点记了一个这个版本不认识的 profile → 拒绝", () => {
    const r = resolveProfileForResume({
      flag: null,
      checkpoint: { profile: "m9-future-pilot" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不认识");
  });

  it("每一个已注册的 profile 名都能被推导出来并加载", () => {
    for (const name of PROFILE_NAMES) {
      const r = resolveProfileForResume({ flag: null, checkpoint: { profile: name } });
      expect(r.ok, name).toBe(true);
      if (r.ok && r.profile) expect(() => loadProfile(r.profile!)).not.toThrow();
    }
  });
});
