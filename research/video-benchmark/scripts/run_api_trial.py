"""Run one paid identity-inference trial, then score it offline.

    python scripts/run_api_trial.py --dry-run      # budget + context check, no call
    python scripts/run_api_trial.py --confirm      # the single paid request
    python scripts/run_api_trial.py --score-only   # re-parse and re-score what is on disk

`--confirm` is required to spend anything, the SDK retries are off, and a bad
response is written to disk as a diagnostic rather than retried. `--score-only`
is the only mode that reads the label, and it needs no network.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.api_trial import (  # noqa: E402
    Pricing, build_request, budget_check, instruction_text, parse_response, read_env_value,
    run_trial, score, sha256_file, validate_prediction,
)
from vbench.util import write_bytes, write_json  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INPUT = REPO_ROOT / "research/data/video-benchmark/runs/full-v2b/agent_pairs_v3/full/input.zh.txt"
DEFAULT_TRIAL = REPO_ROOT / "research/data/video-benchmark/api_trials/2026-09-19-gpt6-astra-full"

# Rates read from the official pricing page immediately before the call. Long-context columns
# are carried so the pre-flight can price the worst case even though a ~12k-token
# request is nowhere near any long-context threshold.
MODEL = "gpt-6-astra"
PRICING = Pricing(
    model=MODEL, input_per_m=10.00, output_per_m=50.00, cached_input_per_m=1.00,
    long_input_per_m=20.00, long_output_per_m=75.00,
    source="https://developers.openai.com/api/docs/pricing (read 2026-09-18 for the full-v2b trial and re-read 2026-09-20 immediately before the game2-v1-r1 trial; re-read again 2026-09-20 immediately before the game3-v1 trial; unchanged all three times: 10/1/50 standard, 20/75 long context)",
)
CONTEXT_WINDOW = 1_050_000
MAX_OUTPUT_TOKENS = 16_000
REASONING_EFFORT = "high"
BUDGET_USD = 2.00
SEATS = list(range(1, 11))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--trial-dir", type=Path, default=DEFAULT_TRIAL)
    ap.add_argument("--env-file", type=Path, default=REPO_ROOT / ".env.local")
    ap.add_argument("--key-var", default="OPENAI_API_KEY_DEV")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--max-output-tokens", type=int, default=MAX_OUTPUT_TOKENS)
    ap.add_argument("--effort", default=REASONING_EFFORT)
    ap.add_argument("--budget-usd", type=float, default=BUDGET_USD)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--confirm", action="store_true", help="必须显式给出才会真的付费调用")
    ap.add_argument("--score-only", action="store_true")
    args = ap.parse_args()

    trial = args.trial_dir
    game_text = args.input.read_text(encoding="utf-8")
    instruction = instruction_text()
    req = build_request(game_text=game_text, instruction=instruction, model=args.model,
                        max_output_tokens=args.max_output_tokens, reasoning_effort=args.effort)

    if args.score_only:
        return do_score(trial, args)

    check = budget_check(req, PRICING, args.budget_usd, CONTEXT_WINDOW)
    print(json.dumps({"input_sha256": sha256_file(args.input), "model": args.model,
                      "pricing": PRICING.__dict__, "check": check}, ensure_ascii=False, indent=2))
    if not check["may_send"]:
        print("\n拒绝发送：最坏情况超出预算或上下文放不下。", file=sys.stderr)
        return 2
    if args.dry_run:
        print("\n--dry-run：没有发送任何请求。")
        return 0
    if not args.confirm:
        print("\n未加 --confirm：没有发送任何请求。", file=sys.stderr)
        return 1

    trial.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.input, trial / "input.zh.txt")
    write_bytes(trial / "input.sha256", (sha256_file(args.input) + "  input.zh.txt\n").encode())
    write_bytes(trial / "instruction.zh.txt", instruction.encode("utf-8"))
    # Both halves of the prompt are hashed: "same prompt as last time" is a claim
    # about bytes, and the instruction lives in code that can drift.
    write_bytes(trial / "instruction.sha256",
                (sha256_file(trial / "instruction.zh.txt") + "  instruction.zh.txt\n").encode())
    # The saved config is the request minus the game text: no key, no transcript copy.
    write_json(trial / "request_config.json", {
        "model": req["model"], "max_output_tokens": req["max_output_tokens"],
        "reasoning": req["reasoning"], "text": req["text"], "store": req["store"],
        "tools_enabled": False, "sdk_max_retries": 0,
        "messages": [{"role": "system", "source": "instruction.zh.txt"},
                     {"role": "user", "source": "input.zh.txt", "sent_verbatim": True}],
        "pricing": PRICING.__dict__, "budget_usd": args.budget_usd, "preflight": check,
        "api_key_variable": args.key_var, "api_key_value": "NOT STORED",
    })

    api_key = read_env_value(args.env_file, args.key_var)
    started = datetime.now(timezone.utc).isoformat()
    try:
        resp, elapsed = run_trial(req=req, api_key=api_key)
    except Exception as e:  # noqa: BLE001 — one shot: record and stop, never retry
        write_json(trial / "call_error.json", {"started_utc": started, "error_type": type(e).__name__,
                                               "error": str(e)[:2000], "retried": False})
        print(f"\n调用失败（不重试）：{type(e).__name__}. 诊断写入 {trial / 'call_error.json'}", file=sys.stderr)
        return 3

    raw = resp.model_dump()
    write_json(trial / "response.raw.json", raw)
    usage = raw.get("usage") or {}
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
    meta = {
        "started_utc": started, "elapsed_s": round(elapsed, 2),
        "request_id": getattr(resp, "_request_id", None) or raw.get("id"),
        "response_id": raw.get("id"), "model_id_returned": raw.get("model"),
        "model_id_requested": args.model, "status": raw.get("status"),
        "incomplete_reason": (raw.get("incomplete_details") or {}).get("reason"),
        "usage": {"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                  "reasoning_tokens": (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                  "cached_input_tokens": cached, "total_tokens": usage.get("total_tokens")},
        "estimated_cost_usd": round(PRICING.actual_usd(usage.get("input_tokens") or 0, cached,
                                                       usage.get("output_tokens") or 0), 4),
        "preflight_worst_case_usd": check["worst_case_usd"], "budget_usd": args.budget_usd,
        "pricing": PRICING.__dict__, "retries": 0,
    }
    write_json(trial / "call_meta.json", meta)
    print(json.dumps(meta, ensure_ascii=False, indent=2))

    parsed = parse_response(raw)
    write_json(trial / "prediction.json", {"errors": parsed["errors"], "status": parsed["status"],
                                           "prediction": parsed["prediction"]})
    if parsed["errors"]:
        print(f"\n响应不完整或无法解析，诊断已保存；不再付费重试。", file=sys.stderr)
        return 4
    return do_score(trial, args)


def do_score(trial: Path, args) -> int:
    """Offline: re-parse the saved response and score it. The only label read."""
    raw = json.loads((trial / "response.raw.json").read_text(encoding="utf-8"))
    parsed = parse_response(raw)
    pred = parsed["prediction"]
    errs = parsed["errors"] + (validate_prediction(pred, SEATS) if pred else [])
    write_json(trial / "prediction.json", {"errors": errs, "status": parsed["status"], "prediction": pred})
    if pred is None:
        print(json.dumps({"errors": errs}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 4
    label = json.loads((args.input.parent / "label.json").read_text(encoding="utf-8"))
    result = score(pred, label)
    result["output_validation_errors"] = errs
    result["label_file"] = str(args.input.parent / "label.json")
    write_json(trial / "scoring.json", result)
    print(json.dumps({k: v for k, v in result.items() if k != "per_seat"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
