"""Input ablations on an already-exported sample.

One question this answers: how much of an identity guess comes from what people
said, and how much from what the board recorded? The only honest way to ask is
to hold everything else still — same cutoff, same rules, same blocks in the same
order, same facts, same instruction, same answer key — and withhold exactly one
thing.

Two halves that must not meet, same as `api_trial`:

* `objective_only_text()` builds the ablated document. It sees the public blocks
  document and nothing else: no label, no roster, no private layer.
* `derive_label()` is the evaluator's side. It copies an already-built label onto
  the new input's hash so the two conditions are scored by the same key, and it
  reads the private layer not at all — the roles it carries were resolved when
  the source label was made.
"""

from __future__ import annotations

import copy

from .block_text import render_input
from .util import sha256_bytes


def derived_sample_id(source_sample_id: str, condition: str) -> str:
    """Stable id for an ablated sample. Distinct from its source by construction."""
    key = f"abl|{source_sample_id}|{condition}"
    return "abl-" + sha256_bytes(key.encode())[:16]


def composition_order(text: str) -> list[str]:
    """Role keys in the order a rendered document lists them.

    `blocks.json` is written with sorted keys, so re-rendering from it reorders
    the 身份构成 line relative to the exported document, which was rendered from
    the config's own ordering. Same multiset, different bytes — and a difference
    that is not the ablation has no business being in the comparison.
    """
    from .block_text import ROLE_ZH

    line = next((l for l in text.splitlines() if l.startswith("身份构成：")), "")
    zh_to_key = {v: k for k, v in ROLE_ZH.items()}
    out = []
    for part in line[len("身份构成："):].rstrip("。").split("、"):
        name = part.rsplit(" ", 1)[0].strip()
        if name in zh_to_key:
            out.append(zh_to_key[name])
    return out


def objective_only_text(blocks_doc: dict, like: str | None = None) -> str:
    """The same cutoff with every utterance withheld.

    Takes the public blocks document, so there is no parameter through which a
    label or a private record could arrive. `like` is the source document, used
    only to restore the 身份构成 ordering (see `composition_order`) so that the
    two conditions differ by the withheld speech and by nothing else.
    """
    doc = blocks_doc
    if like:
        order = composition_order(like)
        comp = (blocks_doc.get("rules") or {}).get("role_composition") or {}
        if order and set(order) == set(comp):
            doc = copy.deepcopy(blocks_doc)
            doc["rules"]["role_composition"] = {k: comp[k] for k in order}
    return render_input(doc, speech=False)


def speech_free(text: str) -> bool:
    """No line is a player's utterance, including an unattributed one."""
    from .block_text import speech_lines

    return not speech_lines(text)


def objective_lines(text: str) -> list[str]:
    """Every objective fact line, in order. Used to prove two conditions agree."""
    keys = ("车主：", "车队：", "上票：", "下票：", "看不清：", "未记录：", "票型：",
            "组队结果：", "任务结果：", "失败牌：", "投票：")
    return [l for l in text.splitlines() if l.startswith(keys) or (l.startswith("第") and "组队" in l)]


def derive_label(source_label: dict, *, sample_id: str, input_sha256: str, condition: str,
                 note: str = "") -> dict:
    """The source label rebound to an ablated input. EVALUATOR SIDE ONLY.

    The seats, the scoring mode and the optional targets are copied unchanged —
    the ablation changes what the model was shown, never what the truth is. The
    source label file itself is not touched.
    """
    out = copy.deepcopy(source_label)
    out["sample_id"] = sample_id
    out["input_sha256"] = input_sha256
    out["derived_from"] = {
        "sample_id": source_label["sample_id"],
        "input_sha256": source_label["input_sha256"],
        "condition": condition,
    }
    if note:
        out["derived_from"]["note"] = note
    out["notes"] = list(out.get("notes", [])) + [
        f"输入消融样本（condition={condition}）：真实身份、评分口径与来源样本完全相同，"
        f"只有模型看到的正文不同。来源 sample_id={source_label['sample_id']}。"
    ]
    return out


# ── free baselines on the same cutoff, for comparison ──────────────────────


def baseline_all_good(seats: list[int]) -> dict[int, str]:
    """Call every seat good. The thing any method has to beat."""
    return {s: "good" for s in seats}


def baseline_last_vote(blocks_doc: dict, player_count: int = 10) -> dict:
    """Approvers good, rejecters evil, from the last proposal that actually voted.

    Reads only blocks at or before the cutoff — a forced round carries no vote
    and is skipped. Seats whose vote was unclear or unrecorded are reported as
    uncovered rather than guessed, because a missing vote is not a vote.
    """
    voted = [b for b in blocks_doc["blocks"] if b.get("votes")]
    if not voted:
        return {"available": False, "reason": "该截止点之前没有任何带票型的组队"}
    b = voted[-1]
    v = b["votes"]
    call = {s: "good" for s in v.get("approve") or []}
    call.update({s: "evil" for s in v.get("reject") or []})
    uncovered = sorted(set(range(1, player_count + 1)) - set(call))
    return {
        "available": True,
        "from_block": {"mission": b["mission"], "attempt": b["attempt"],
                       "leader_seat": b["leader_seat"], "tally_text": b.get("tally_text")},
        "calls": {str(k): val for k, val in sorted(call.items())},
        "uncovered_seats": uncovered,
        "unclear": sorted(v.get("unclear") or []),
        "unrecorded": sorted(v.get("unrecorded") or []),
    }


def score_hard_calls(calls: dict[int, str], label: dict) -> dict:
    """Side accuracy for a baseline that gives no probability.

    No Brier: inventing 0/1 confidences for a rule that never expressed any
    would make it look calibrated when it simply never said.
    """
    rows, hits, scored = [], 0, 0
    for seat_s, truth in sorted(label["seats"].items(), key=lambda kv: int(kv[0])):
        seat = int(seat_s)
        if truth["verification"] != "verified":
            rows.append({"seat": seat, "scored": False, "reason": truth["verification"]})
            continue
        got = calls.get(seat)
        if got is None:
            rows.append({"seat": seat, "scored": False, "reason": "baseline makes no call for this seat"})
            continue
        scored += 1
        ok = got == truth["side"]
        hits += ok
        rows.append({"seat": seat, "scored": True, "called_side": got,
                     "true_side": truth["side"], "side_correct": ok})
    return {
        "scored_seats": scored,
        "total_seats": len(label["seats"]),
        "side_correct": hits,
        "side_accuracy": None if not scored else round(hits / scored, 4),
        "brier_score": None,
        "brier_note": "硬分类基线不给概率，不凭空补 0/1 算 Brier。",
        "per_seat": rows,
    }
