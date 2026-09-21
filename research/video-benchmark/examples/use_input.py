"""Minimal offline example: send one input document, score the answer separately.

Nothing here touches the network and nothing needs an API key. The point is the
shape: the *only* thing that goes into the user message is the bytes of
`input.zh.txt`; the instruction is a separate constant file, and the answer is
graded against a label file the model never sees.

    python examples/use_input.py <agent_pairs_v3 dir> [sample_id] [--answer answer.json]

`--answer` takes a JSON object like {"1": "忠臣", "2": "梅林", ...} — a model's
reply saved to disk — and prints the score. Without it the script only shows the
message it would have sent.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROLE_ZH = {"merlin": "梅林", "percival": "派西维尔", "loyal": "忠臣", "morgana": "莫甘娜",
           "mordred": "莫德雷德", "assassin": "刺客", "oberon": "奥伯伦"}
SIDE_ZH = {"good": "好人", "evil": "坏人"}


def build_messages(pair_dir: Path, sample_id: str) -> list[dict]:
    """The exact request body. Reads the input only — never the label."""
    manifest = json.loads((pair_dir / "manifest.json").read_text(encoding="utf-8"))
    entry = next(p for p in manifest["pairs"] if p["sample_id"] == sample_id)
    instruction = (pair_dir / manifest["instruction_file"]).read_text(encoding="utf-8")
    game_text = (pair_dir / entry["input_path"]).read_text(encoding="utf-8")
    # System = the fixed task; user = the public record, byte for byte.
    return [{"role": "system", "content": instruction}, {"role": "user", "content": game_text}]


def score(pair_dir: Path, sample_id: str, answer: dict) -> dict:
    """Grade an answer against the label file, opened only here."""
    manifest = json.loads((pair_dir / "manifest.json").read_text(encoding="utf-8"))
    entry = next(p for p in manifest["pairs"] if p["sample_id"] == sample_id)
    label = json.loads((pair_dir / entry["label_path"]).read_text(encoding="utf-8"))
    rows, roles_ok, sides_ok, scored = [], 0, 0, 0
    for seat in sorted(label["seats"], key=int):
        truth = label["seats"][seat]
        if truth["verification"] != "verified":
            rows.append({"seat": int(seat), "scored": False, "reason": truth["verification"]})
            continue
        scored += 1
        got = str(answer.get(seat, "")).strip()
        want_role, want_side = ROLE_ZH[truth["role"]], truth["side"]
        got_side = "good" if got in ("梅林", "派西维尔", "忠臣") else ("evil" if got in ROLE_ZH.values() else None)
        roles_ok += got == want_role
        sides_ok += got_side == want_side
        rows.append({"seat": int(seat), "scored": True, "answer": got, "truth": want_role,
                     "role_correct": got == want_role, "side_correct": got_side == want_side})
    return {"sample_id": sample_id, "scored_seats": scored, "role_correct": roles_ok,
            "side_correct": sides_ok, "scoring_mode": label["scoring"]["mode"], "seats": rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pair_dir", type=Path)
    ap.add_argument("sample_id", nargs="?", default=None, help="默认用完整对局的那一份")
    ap.add_argument("--answer", type=Path, default=None)
    args = ap.parse_args()

    manifest = json.loads((args.pair_dir / "manifest.json").read_text(encoding="utf-8"))
    sample_id = args.sample_id or next(p["sample_id"] for p in manifest["pairs"] if p["kind"] == "full")
    messages = build_messages(args.pair_dir, sample_id)

    print(f"sample: {sample_id}")
    print(f"user message: {len(messages[1]['content'])} 字符 / {len(messages[1]['content'].encode('utf-8'))} UTF-8 字节")
    print("--- 前 400 字 ---")
    print(messages[1]["content"][:400])
    print("...")
    print("\n发送时就是这样一条请求（这里不联网、不需要 key）：")
    print("    client.messages.create(model=..., system=messages[0]['content'], messages=[messages[1]], max_tokens=2000)")

    if args.answer:
        res = score(args.pair_dir, sample_id, json.loads(args.answer.read_text(encoding="utf-8")))
        print(f"\n逐座位身份：{res['role_correct']}/{res['scored_seats']}；阵营：{res['side_correct']}/{res['scored_seats']}")
        for r in res["seats"]:
            if r["scored"] and not r["role_correct"]:
                print(f"  {r['seat']}号 答 {r['answer'] or '（空）'}，实际 {r['truth']}")


if __name__ == "__main__":
    main()
