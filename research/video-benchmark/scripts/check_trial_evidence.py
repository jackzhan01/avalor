"""Check a trial's cited evidence against the document it was given.

"The model quoted correctly" and "the model inferred correctly" are different
results, and a report that mixes them overstates what a run showed. This script
only settles the first one, and only for claims a machine can settle: team
membership, per-seat votes, proposal leaders, mission results and fail counts
come from `blocks.json`, and quoted fragments are searched byte for byte in the
input that was actually sent.

Anything it cannot decide is emitted as `undecidable` with a reason, never as a
pass. Reading intent ("持续偏站9号") is left to a human.

    python scripts/check_trial_evidence.py <trial_dir> <blocks.json> <claims.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.util import sha256_bytes, write_json  # noqa: E402


def _block(blocks: list[dict], mission: int, attempt: int) -> dict:
    for b in blocks:
        if b["mission"] == mission and b["attempt"] == attempt:
            return b
    raise KeyError(f"no block for mission {mission} attempt {attempt}")


def _votes(b: dict, kind: str) -> list[int]:
    v = b.get("votes")
    return [] if v is None else list(v.get(kind) or [])


PREDICATES = {
    # membership and roles inside one proposal
    "team_is": lambda b, a: sorted(b["team_seats"]) == sorted(a["seats"]),
    "in_team": lambda b, a: a["seat"] in (b["team_seats"] or []),
    "not_in_team": lambda b, a: a["seat"] not in (b["team_seats"] or []),
    "leader_is": lambda b, a: b["leader_seat"] == a["seat"],
    # votes
    "approved": lambda b, a: a["seat"] in _votes(b, "approve"),
    "rejected": lambda b, a: a["seat"] in _votes(b, "reject"),
    "sole_approver": lambda b, a: _votes(b, "approve") == [a["seat"]],
    "tally_is": lambda b, a: b["tally_text"] == a["tally"],
    "outcome_is": lambda b, a: b["outcome"] == a["outcome"],
    # mission
    "mission_result_is": lambda b, a: b["mission_ran"] and b["mission_result"] == a["result"],
    "fail_count_is": lambda b, a: b["mission_ran"] and b["fail_count"] == a["count"],
    "forced_no_vote": lambda b, a: bool(b["forced"]) and b.get("votes") is None,
}


def evaluate(claims: list[dict], blocks: list[dict], text: str) -> list[dict]:
    out = []
    for c in claims:
        row = {"seat": c.get("seat"), "claim": c["claim"], "kind": c["kind"]}
        try:
            if c["kind"] == "quote":
                row["verified"] = c["quote"] in text
                row["quote"] = c["quote"]
            elif c["kind"] == "quote_before":
                # "X said this before Y happened": a fragment that only turns up
                # later in the document cannot be what someone acted on earlier.
                anchor = text.find(c["anchor"])
                found = text.find(c["quote"])
                row["verified"] = found != -1 and anchor != -1 and found < anchor
                row["quote"], row["anchor"] = c["quote"], c["anchor"]
                row["first_occurrence_before_anchor"] = row["verified"]
            elif c["kind"] == "undecidable":
                row["verified"] = None
                row["reason"] = c["reason"]
            else:
                b = _block(blocks, c["mission"], c["attempt"])
                row["verified"] = bool(PREDICATES[c["kind"]](b, c))
                row["checked_against"] = f"第{c['mission']}轮第{c['attempt']}次组队"
        except (KeyError, TypeError) as e:  # a claim about something not in the record
            row["verified"] = False
            row["error"] = f"{type(e).__name__}: {e}"
        out.append(row)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trial_dir", type=Path)
    ap.add_argument("blocks", type=Path)
    ap.add_argument("claims", type=Path)
    ap.add_argument("--out", default="evidence_check.json")
    args = ap.parse_args()

    raw = (args.trial_dir / "input.zh.txt").read_bytes()
    text = raw.decode("utf-8")
    doc = json.loads(args.blocks.read_text(encoding="utf-8"))
    spec = json.loads(args.claims.read_text(encoding="utf-8"))
    rows = evaluate(spec["claims"], doc["blocks"], text)

    facts = [r for r in rows if r["kind"] not in ("quote", "quote_before", "undecidable")]
    quotes = [r for r in rows if r["kind"] in ("quote", "quote_before")]
    undecided = [r for r in rows if r["kind"] == "undecidable"]
    report = {
        "method": ("每条可机器判定的断言都由 blocks.json 的客观字段求值（车队、车主、逐座位票、比分、"
                   "任务结果、失败牌），引用片段在实际发送的 input.zh.txt 里逐字节查找；判不了的进 undecidable，"
                   "不计入通过。"),
        "input_sha256": sha256_bytes(raw),
        "blocks_file": str(args.blocks),
        "factual_claims": facts,
        "factual_verified": sum(1 for r in facts if r["verified"]),
        "factual_total": len(facts),
        "quoted_fragments": quotes,
        "quotes_verified": sum(1 for r in quotes if r["verified"]),
        "quotes_total": len(quotes),
        "undecidable": undecided,
        "caveat": spec.get("caveat", ""),
    }
    write_json(args.trial_dir / args.out, report)
    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("factual_claims", "quoted_fragments", "undecidable")},
                     ensure_ascii=False, indent=2))
    bad = [r for r in facts + quotes if not r["verified"]]
    for r in bad:
        print(f"  未通过: 座位{r['seat']} {r['claim']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
