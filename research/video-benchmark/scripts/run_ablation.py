"""Freeze, check, run and score a two-condition input ablation on one cutoff.

    python scripts/run_ablation.py --freeze     # build A and B, run every pre-check, spend nothing
    python scripts/run_ablation.py --confirm A  # the one paid request for condition A
    python scripts/run_ablation.py --confirm B  # the one paid request for condition B
    python scripts/run_ablation.py --score      # offline; the only step that reads the label

Both conditions are written to disk by `--freeze`, before either call, so the
second condition cannot be edited in the light of the first one's answer. Each
condition may be called exactly once: `--confirm` refuses if a response for that
condition is already on disk.

The label is read in two places and nowhere else: `--freeze` compares hashes
(and never puts a label value into the request or a log), and `--score` scores.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.ablation import (  # noqa: E402
    baseline_all_good, baseline_last_vote, derive_label, derived_sample_id, objective_lines,
    objective_only_text, score_hard_calls, speech_free,
)
from vbench.api_trial import (  # noqa: E402
    Pricing, build_request, budget_check, instruction_text, parse_response, read_env_value,
    run_trial, score, sha256_file, validate_prediction,
)
from vbench.util import read_json, sha256_bytes, write_bytes, write_json  # noqa: E402
from vbench.validate import input_text_errors, record_errors  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "research/data/video-benchmark"
SOURCE_DIR = DATA / "runs/game3-v1/agent_pairs_v3/cutoffs/p3-0125783472255f09"
MANIFEST = DATA / "runs/game3-v1/agent_pairs_v3/manifest.json"
EXP = DATA / "api_trials/2026-09-21-gpt6-astra-game3-m3-ablation"
BASELINE_TRIAL = DATA / "api_trials/2026-09-20-gpt6-astra-game3-v1"

SOURCE_SAMPLE_ID = "p3-0125783472255f09"
EXPECT_CUTOFF_LABEL = "m3 mission outcome"
MODEL = "gpt-6-astra"
PRICING = Pricing(
    model=MODEL, input_per_m=10.00, output_per_m=50.00, cached_input_per_m=1.00,
    long_input_per_m=20.00, long_output_per_m=75.00,
    source="https://developers.openai.com/api/docs/pricing (re-read 2026-09-21 immediately before this experiment; unchanged: 10/1/50 standard, 20/75 long context)",
)
CONTEXT_WINDOW = 1_050_000
MAX_OUTPUT_TOKENS = 16_000
REASONING_EFFORT = "high"
PER_CALL_BUDGET = 2.00
TOTAL_BUDGET = 4.00
SEATS = list(range(1, 11))
CONDITIONS = {"A": "A-full", "B": "B-objective-only"}


def fail(msg: str):
    print(f"预检失败：{msg}", file=sys.stderr)
    raise SystemExit(2)


# ── freeze ─────────────────────────────────────────────────────────────────


def freeze() -> int:
    man = read_json(MANIFEST)
    entry = next((p for p in man["pairs"] if p["sample_id"] == SOURCE_SAMPLE_ID), None)
    if entry is None:
        fail(f"manifest 里没有 {SOURCE_SAMPLE_ID}")
    if entry["cutoff_label"] != EXPECT_CUTOFF_LABEL:
        fail(f"{SOURCE_SAMPLE_ID} 的 cutoff_label 是 {entry['cutoff_label']!r}，不是 {EXPECT_CUTOFF_LABEL!r}")

    a_raw = (SOURCE_DIR / "input.zh.txt").read_bytes()
    a_text = a_raw.decode("utf-8")
    blocks = read_json(SOURCE_DIR / "blocks.json")
    src_label = read_json(SOURCE_DIR / "label.json")

    checks: list[tuple[str, bool, str]] = []

    def ck(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    # 1. A is the exported bytes, bound to its own label and manifest
    a_sha = sha256_bytes(a_raw)
    ck("A input 字节 = label.input_sha256", a_sha == src_label["input_sha256"], a_sha[:16] + "…")
    ck("A input 字节 = manifest.input_sha256", a_sha == entry["input_sha256"])
    ck("A 未被改写（与导出产物同一文件）", (SOURCE_DIR / "input.zh.txt").exists())

    # 2. build B from the same blocks
    b_text = objective_only_text(blocks, like=a_text)
    b_raw = b_text.encode("utf-8")
    b_sha = sha256_bytes(b_raw)
    ck("B 与 A 的正文哈希不同", b_sha != a_sha)

    # 3. the cutoff really stops after mission 3's result
    last = blocks["blocks"][-1]
    ck("最后一个 block 是第3轮第1次组队", (last["mission"], last["attempt"]) == (3, 1),
       f"{last['mission']}/{last['attempt']}")
    ck("第3轮任务失败", last["mission_result"] == "fail")
    ck("第3轮 1 张失败牌", last["fail_count"] == 1)
    for tag, txt in (("A", a_text), ("B", b_text)):
        ck(f"{tag} 写明任务结果：失败", "任务结果：失败" in txt)
        ck(f"{tag} 写明失败牌：1", "失败牌：1" in txt)
        ck(f"{tag} 覆盖说明到第3轮任务结束", "本记录到第 3 轮任务结束为止。" in txt)
        ck(f"{tag} 不含第4轮任何内容", "第4轮" not in txt and "第 4 轮" not in txt)
        ck(f"{tag} 不含刺杀信息", not any(w in txt for w in ("刺杀", "刺客决定", "盘刀", "赛后", "阵营获胜")))
        ck(f"{tag} 正文禁止模式", not input_text_errors(txt))

    # 4. B holds no speech at all, not even an unattributed line
    ck("B 没有任何玩家发言（含说话人未知）", speech_free(b_text))
    ck("B 不含「说话人未知」", "说话人未知" not in b_text)
    ck("B 不写「无人发言」类说法",
       not any(w in b_text for w in ("发言：未记录", "发言：部分未记录", "本段未见玩家发言",
                                     "无人发言", "没有人发言", "所有人都没说话")))
    ck("A 确实有发言（对照组成立）", not speech_free(a_text))

    # 5. the objective layer is identical; only speech was removed
    a_obj, b_obj = objective_lines(a_text), objective_lines(b_text)
    ck("A、B 的客观字段逐行完全相同", a_obj == b_obj, f"{len(a_obj)} 行")
    ck("B 只是 A 去掉发言，没有压缩或改写", len(b_text) < len(a_text) and a_obj == b_obj)
    ck("正式车队只来自 blocks 字段，不取自原话",
       all(l.startswith(("车队：", "车主：")) is False or l in a_obj for l in b_obj))
    # header stays identical apart from the one explainer line
    a_head = [l for l in a_text.split("以下按每次组队分段")[0].splitlines() if l]
    b_head = [l for l in b_text.split("以下按每次组队分段")[0].splitlines() if l]
    ck("A、B 的规则/构成/座位/湖中女神/覆盖说明完全相同", a_head == b_head, f"{len(a_head)} 行")

    # 6. label binding for B, derived not rewritten
    b_sample_id = derived_sample_id(SOURCE_SAMPLE_ID, "objective_only")
    b_label = derive_label(src_label, sample_id=b_sample_id, input_sha256=b_sha,
                           condition="objective_only",
                           note="同一截止点，withheld: 全部玩家原话与发言覆盖说明")
    ck("B 的 sample_id 与来源不同", b_sample_id != SOURCE_SAMPLE_ID, b_sample_id)
    ck("B label 绑定 B 的正文哈希", b_label["input_sha256"] == b_sha)
    ck("B label 的 seats 与来源逐字相同", b_label["seats"] == src_label["seats"])
    ck("B label 记录 derived_from", b_label["derived_from"]["sample_id"] == SOURCE_SAMPLE_ID)
    ck("B label schema", not record_errors(b_label, "agent_label"))
    ck("来源 label 未被修改", read_json(SOURCE_DIR / "label.json") == src_label)

    # 7. budget, for both calls together
    instruction = instruction_text()
    reqs = {}
    for tag, txt in (("A", a_text), ("B", b_text)):
        req = build_request(game_text=txt, instruction=instruction, model=MODEL,
                            max_output_tokens=MAX_OUTPUT_TOKENS, reasoning_effort=REASONING_EFFORT)
        chk = budget_check(req, PRICING, PER_CALL_BUDGET, CONTEXT_WINDOW)
        reqs[tag] = chk
        ck(f"{tag} 最坏情况 ≤ ${PER_CALL_BUDGET}", chk["within_budget"], f"${chk['worst_case_usd']}")
        ck(f"{tag} 放得进上下文", chk["fits_context"])
    total = round(reqs["A"]["worst_case_usd"] + reqs["B"]["worst_case_usd"], 4)
    ck(f"两次合计最坏 ≤ ${TOTAL_BUDGET}", total <= TOTAL_BUDGET, f"${total}")

    # 8. the prompt is the one the full-game trial actually sent
    saved_instr = (BASELINE_TRIAL / "instruction.zh.txt").read_bytes()
    ck("instruction 与第三局完整试跑逐字节相同", saved_instr == instruction.encode("utf-8"))
    saved_fmt = read_json(BASELINE_TRIAL / "request_config.json")["text"]["format"]
    cur_fmt = build_request(game_text="x", instruction="y", model=MODEL,
                            max_output_tokens=MAX_OUTPUT_TOKENS, reasoning_effort=REASONING_EFFORT)["text"]["format"]
    ck("输出 schema 与第三局完整试跑相同",
       json.dumps(saved_fmt, sort_keys=True) == json.dumps(cur_fmt, sort_keys=True))

    # 9. no label value can have reached the request
    blob = json.dumps([build_request(game_text=t, instruction=instruction, model=MODEL,
                                     max_output_tokens=MAX_OUTPUT_TOKENS,
                                     reasoning_effort=REASONING_EFFORT)
                       for t in (a_text, b_text)], ensure_ascii=False)
    ck("请求里没有 <座位>:<真实身份> 形式的答案",
       not [s for s, v in src_label["seats"].items() if f'"{s}": "{v["role"]}"' in blob])
    ck("请求里没有 label 的字段名",
       not any(k in blob for k in ("verification", "optional_targets", "input_sha256", "assassin_seat")))

    print("### 冻结前预检")
    bad = []
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")
        if not ok:
            bad.append(name)
    if bad:
        fail(f"{len(bad)} 项未通过：{bad}")

    # write both conditions now, before any call
    for tag, cond_dir, txt, raw in (("A", CONDITIONS["A"], a_text, a_raw), ("B", CONDITIONS["B"], b_text, b_raw)):
        d = EXP / cond_dir
        d.mkdir(parents=True, exist_ok=True)
        write_bytes(d / "input.zh.txt", raw if tag == "A" else txt.encode("utf-8"))
        write_bytes(d / "input.sha256", (sha256_file(d / "input.zh.txt") + "  input.zh.txt\n").encode())
        write_bytes(d / "instruction.zh.txt", instruction.encode("utf-8"))
        write_bytes(d / "instruction.sha256",
                    (sha256_file(d / "instruction.zh.txt") + "  instruction.zh.txt\n").encode())
    write_json(EXP / CONDITIONS["B"] / "label.json", b_label)

    exp = {
        "schema": "vbench.ablation_experiment/1",
        "frozen_utc": datetime.now(timezone.utc).isoformat(),
        "question": ("在第4轮票型尚不可见时，模型能否判断阵营；以及玩家发言相对客观事件是否提供额外帮助。"
                     "两组只差一件事：B 隐去全部玩家原话。"),
        "source": {"run_id": "game3-v1", "sample_id": SOURCE_SAMPLE_ID,
                   "cutoff_label": entry["cutoff_label"], "cutoff_sequence": entry["cutoff_sequence"],
                   "cutoff_public_at": entry["cutoff_public_at"],
                   "dir": str(SOURCE_DIR), "input_sha256": a_sha, "label_sha256": entry["label_sha256"]},
        "conditions": {
            "A": {"dir": CONDITIONS["A"], "name": "full", "sample_id": SOURCE_SAMPLE_ID,
                  "input_sha256": a_sha, "label": str(SOURCE_DIR / "label.json"),
                  "withheld": [], "characters": len(a_text)},
            "B": {"dir": CONDITIONS["B"], "name": "objective_only", "sample_id": b_sample_id,
                  "input_sha256": b_sha, "label": f"{CONDITIONS['B']}/label.json",
                  "withheld": ["全部玩家原话", "发言覆盖说明（未记录/部分未记录/本段未见玩家发言）"],
                  "characters": len(b_text),
                  "note": "省略发言是实验处理；正文没有、也不得有任何『无人发言』的说法。"},
        },
        "objective_fields_identical": a_obj == b_obj,
        "objective_line_count": len(a_obj),
        "instruction_sha256": sha256_bytes(instruction.encode("utf-8")),
        "instruction_source": str(BASELINE_TRIAL / "instruction.zh.txt"),
        "output_schema_source": str(BASELINE_TRIAL / "request_config.json"),
        "api": {"model": MODEL, "reasoning_effort": REASONING_EFFORT,
                "max_output_tokens": MAX_OUTPUT_TOKENS, "store": False, "tools_enabled": False,
                "sdk_max_retries": 0, "fresh_request_no_prior_context": True},
        "budget": {"per_call_usd": PER_CALL_BUDGET, "total_usd": TOTAL_BUDGET,
                   "preflight": reqs, "worst_case_total_usd": total},
        "pricing": PRICING.__dict__,
        "max_calls_per_condition": 1,
        "preflight_checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks],
    }
    write_json(EXP / "experiment.json", exp)

    # free baselines, computed now so they cannot be tuned to the results
    seats = [int(s) for s in src_label["seats"]]
    write_json(EXP / "baselines.json", {
        "note": ("两条固定基线，不调用 API，在看到任何模型输出之前算好。硬分类不给概率，"
                 "因此只比阵营准确率，不算 Brier。"),
        "cutoff": EXPECT_CUTOFF_LABEL,
        "all_good": {"calls": {str(k): v for k, v in baseline_all_good(seats).items()}},
        "last_voted_proposal": baseline_last_vote(blocks),
    })
    print(f"\n已冻结两组条件到 {EXP}")
    print(f"  A {len(a_text)} 字符 / B {len(b_text)} 字符；客观行 {len(a_obj)} 行，两组完全相同")
    print(f"  预算：A ${reqs['A']['worst_case_usd']} + B ${reqs['B']['worst_case_usd']} = ${total} ≤ ${TOTAL_BUDGET}")
    return 0


# ── call ───────────────────────────────────────────────────────────────────


def call(tag: str, args) -> int:
    exp = read_json(EXP / "experiment.json")
    d = EXP / CONDITIONS[tag]
    if (d / "response.raw.json").exists() or (d / "call_error.json").exists():
        fail(f"条件 {tag} 已经有调用记录，拒绝重复付费：{d}")
    spent = 0.0
    for other in CONDITIONS.values():
        meta = EXP / other / "call_meta.json"
        if meta.exists():
            spent += read_json(meta)["estimated_cost_usd"]
    chk = exp["budget"]["preflight"][tag]
    if spent + chk["worst_case_usd"] > TOTAL_BUDGET:
        fail(f"已花费 ${spent:.4f} + 本次最坏 ${chk['worst_case_usd']} 会超出总预算 ${TOTAL_BUDGET}")
    if not chk["may_send"]:
        fail(f"条件 {tag} 的预检不允许发送")

    text = (d / "input.zh.txt").read_text(encoding="utf-8")
    instruction = (d / "instruction.zh.txt").read_text(encoding="utf-8")
    if sha256_bytes(text.encode("utf-8")) != exp["conditions"][tag]["input_sha256"]:
        fail(f"条件 {tag} 的正文与冻结时的哈希不一致，拒绝发送")
    req = build_request(game_text=text, instruction=instruction, model=MODEL,
                        max_output_tokens=MAX_OUTPUT_TOKENS, reasoning_effort=REASONING_EFFORT)
    write_json(d / "request_config.json", {
        "condition": tag, "model": req["model"], "max_output_tokens": req["max_output_tokens"],
        "reasoning": req["reasoning"], "text": req["text"], "store": req["store"],
        "tools_enabled": False, "sdk_max_retries": 0,
        "messages": [{"role": "system", "source": "instruction.zh.txt"},
                     {"role": "user", "source": "input.zh.txt", "sent_verbatim": True}],
        "pricing": PRICING.__dict__, "budget_usd": PER_CALL_BUDGET, "preflight": chk,
        "api_key_variable": args.key_var, "api_key_value": "NOT STORED",
        "prior_context": None,
    })

    api_key = read_env_value(args.env_file, args.key_var)
    started = datetime.now(timezone.utc).isoformat()
    try:
        resp, elapsed = run_trial(req=req, api_key=api_key)
    except Exception as e:  # noqa: BLE001 — one shot per condition
        write_json(d / "call_error.json", {"condition": tag, "started_utc": started,
                                           "error_type": type(e).__name__, "error": str(e)[:2000],
                                           "retried": False})
        print(f"\n条件 {tag} 调用失败（不重试）：{type(e).__name__}", file=sys.stderr)
        return 3

    raw = resp.model_dump()
    write_json(d / "response.raw.json", raw)
    usage = raw.get("usage") or {}
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
    meta = {
        "condition": tag, "started_utc": started, "elapsed_s": round(elapsed, 2),
        "request_id": getattr(resp, "_request_id", None) or raw.get("id"),
        "response_id": raw.get("id"), "model_id_returned": raw.get("model"),
        "model_id_requested": MODEL, "status": raw.get("status"),
        "incomplete_reason": (raw.get("incomplete_details") or {}).get("reason"),
        "usage": {"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                  "reasoning_tokens": (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                  "cached_input_tokens": cached, "total_tokens": usage.get("total_tokens")},
        "estimated_cost_usd": round(PRICING.actual_usd(usage.get("input_tokens") or 0, cached,
                                                       usage.get("output_tokens") or 0), 4),
        "preflight_worst_case_usd": chk["worst_case_usd"],
        "spent_before_this_call_usd": round(spent, 4),
        "pricing": PRICING.__dict__, "retries": 0,
    }
    write_json(d / "call_meta.json", meta)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    parsed = parse_response(raw)
    write_json(d / "prediction.json", {"condition": tag, "errors": parsed["errors"],
                                       "status": parsed["status"], "prediction": parsed["prediction"]})
    if parsed["errors"]:
        print(f"\n条件 {tag} 的响应不完整或无法解析；诊断已保存，不补跑。", file=sys.stderr)
        return 4
    return 0


# ── score ──────────────────────────────────────────────────────────────────


def do_score() -> int:
    exp = read_json(EXP / "experiment.json")
    labels = {"A": read_json(SOURCE_DIR / "label.json"),
              "B": read_json(EXP / CONDITIONS["B"] / "label.json")}
    out = {}
    for tag, cond_dir in CONDITIONS.items():
        d = EXP / cond_dir
        if not (d / "response.raw.json").exists():
            print(f"条件 {tag} 没有响应，跳过评分。", file=sys.stderr)
            continue
        raw = read_json(d / "response.raw.json")
        parsed = parse_response(raw)
        pred = parsed["prediction"]
        errs = parsed["errors"] + (validate_prediction(pred, SEATS) if pred else [])
        write_json(d / "prediction.json", {"condition": tag, "errors": errs,
                                           "status": parsed["status"], "prediction": pred})
        if pred is None:
            continue
        label = labels[tag]
        text_sha = sha256_file(d / "input.zh.txt")
        if text_sha != label["input_sha256"]:
            fail(f"条件 {tag} 的正文哈希与其 label 不符，拒绝评分")
        res = score(pred, label)
        res["condition"] = tag
        res["output_validation_errors"] = errs
        res["label_file"] = str(SOURCE_DIR / "label.json") if tag == "A" else str(d / "label.json")
        res["input_sha256"] = text_sha
        write_json(d / "scoring.json", res)
        out[tag] = res
    write_json(EXP / "comparison.json", build_comparison(exp, out))
    print(json.dumps({t: {k: v for k, v in r.items() if k != "per_seat"} for t, r in out.items()},
                     ensure_ascii=False, indent=2))
    return 0


def build_comparison(exp: dict, results: dict) -> dict:
    base = read_json(EXP / "baselines.json")
    label = read_json(SOURCE_DIR / "label.json")
    seats = sorted(int(s) for s in label["seats"])
    rows = []
    for seat in seats:
        row = {"seat": seat, "true_role": label["seats"][str(seat)]["role"],
               "true_side": label["seats"][str(seat)]["side"]}
        for tag, res in results.items():
            r = next((x for x in res["per_seat"] if x["seat"] == seat and x.get("scored")), None)
            if r:
                row[tag] = {"evil_probability": r["evil_probability"], "predicted_side": r["predicted_side"],
                            "predicted_role": r["predicted_role"], "side_correct": r["side_correct"],
                            "role_correct": r["role_correct"]}
        if "A" in row and "B" in row:
            row["delta_evil_probability"] = round(row["B"]["evil_probability"] - row["A"]["evil_probability"], 4)
            row["side_call_changed"] = row["A"]["predicted_side"] != row["B"]["predicted_side"]
            row["role_call_changed"] = row["A"]["predicted_role"] != row["B"]["predicted_role"]
        rows.append(row)
    all_good = score_hard_calls({int(k): v for k, v in base["all_good"]["calls"].items()}, label)
    lv = base["last_voted_proposal"]
    last_vote = (score_hard_calls({int(k): v for k, v in lv["calls"].items()}, label)
                 if lv.get("available") else {"available": False, "reason": lv.get("reason")})
    spent = {}
    for tag, cond_dir in CONDITIONS.items():
        m = EXP / cond_dir / "call_meta.json"
        spent[tag] = read_json(m)["estimated_cost_usd"] if m.exists() else None
    return {
        "schema": "vbench.ablation_comparison/1",
        "cutoff": exp["source"]["cutoff_label"],
        "conditions": {t: {k: v for k, v in c.items() if k in ("name", "sample_id", "input_sha256", "withheld")}
                       for t, c in exp["conditions"].items()},
        "headline": {t: {"side_accuracy": r["side_accuracy"], "brier_score": r["brier_score"],
                         "role_accuracy": r["role_accuracy"], "abstentions_unknown": r["abstentions_unknown"]}
                     for t, r in results.items()},
        "baselines": {
            "all_good": {"side_accuracy": all_good["side_accuracy"], "side_correct": all_good["side_correct"],
                         "scored_seats": all_good["scored_seats"], "brier_score": None},
            "last_voted_proposal": dict(last_vote, from_block=lv.get("from_block"),
                                        uncovered_seats=lv.get("uncovered_seats")),
        },
        "per_seat": rows,
        "cost_usd": spent,
        "caveat": ("每个条件只有一次采样，没有重复实验。A 与 B 的差异是本次观察到的差异，"
                   "不能当作『发言』的因果效应量。"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true")
    ap.add_argument("--confirm", choices=["A", "B"], default=None)
    ap.add_argument("--score", action="store_true")
    ap.add_argument("--env-file", type=Path, default=REPO / ".env.local")
    ap.add_argument("--key-var", default="OPENAI_API_KEY_DEV")
    args = ap.parse_args()
    if args.freeze:
        return freeze()
    if args.confirm:
        return call(args.confirm, args)
    if args.score:
        return do_score()
    ap.error("给 --freeze / --confirm A|B / --score 之一")


if __name__ == "__main__":
    raise SystemExit(main())
