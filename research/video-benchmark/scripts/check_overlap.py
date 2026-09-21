"""Are two runs the same real game re-cut? Compare what was actually said.

Duration and file hash only prove the *files* differ; a re-upload with a
different edit would still be the same game and must land in the same split
group. This compares caption text (character 5-grams) and the board's team
compositions, which a re-cut cannot change.

    python scripts/check_overlap.py run_a run_b [run_c ...]
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.paths import run_paths  # noqa: E402
from vbench.util import read_jsonl  # noqa: E402


def _grams(texts: list[str], n: int = 5) -> set[str]:
    out = set()
    for t in texts:
        s = "".join(t.split())
        out |= {s[i:i + n] for i in range(max(0, len(s) - n + 1))}
    return out


def run_fingerprint(run_id: str) -> dict:
    run = run_paths(run_id)
    if not (run.public / "utterances.jsonl").is_file() or not (run.public / "events.jsonl").is_file():
        raise ValueError(f"缺少抽取文件，不能判定是否同局：{run_id}")
    utts = read_jsonl(run.public / "utterances.jsonl")
    events = read_jsonl(run.public / "events.jsonl")
    texts = [(u["caption"] or {}).get("text") or "" for u in utts]
    if not _grams(texts) or not events:
        raise ValueError(f"抽取证据不足，不能判定是否同局：{run_id}")
    teams = sorted({
        (e["payload"].get("mission"), tuple(sorted(e["payload"].get("team_seats") or [])))
        for e in events if e["type"] == "team_selection" and e["payload"].get("team_seats")
    })
    return {"run_id": run_id, "captions": len([t for t in texts if t]), "grams": _grams(texts),
            "teams": teams, "events": len(events)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    args = ap.parse_args()
    fps = [run_fingerprint(r) for r in args.runs]
    out = {"runs": [{k: (len(v) if k == "grams" else v) for k, v in f.items()} for f in fps], "pairs": []}
    for a, b in itertools.combinations(fps, 2):
        inter = len(a["grams"] & b["grams"])
        union = len(a["grams"] | b["grams"]) or 1
        shared_teams = sorted(set(a["teams"]) & set(b["teams"]))
        jac = inter / union
        out["pairs"].append({
            "a": a["run_id"], "b": b["run_id"],
            "caption_5gram_jaccard": round(jac, 4), "shared_5grams": inter,
            "shared_team_compositions": [[m, list(t)] for m, t in shared_teams],
            "verdict": ("SAME GAME (re-cut): group them together" if jac > 0.3 or len(shared_teams) >= 3
                        else "different games" if jac < 0.05 and len(shared_teams) <= 1
                        else "INCONCLUSIVE: look at it by hand"),
        })
    print(json.dumps({k: v for k, v in out.items()}, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
