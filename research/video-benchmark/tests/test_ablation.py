"""The input ablation: what condition B may drop, and what it may not touch.

An ablation is only worth running if exactly one thing changed. Every test here
pins one way the two conditions could quietly diverge — a reworded header, a
reordered composition line, a fact that only lived in the speech, a label that
followed the input instead of the truth.
"""

import copy
import json

import pytest
from test_agent_blocks import build, game

from vbench.ablation import (
    baseline_all_good, baseline_last_vote, composition_order, derive_label, derived_sample_id,
    objective_lines, objective_only_text, score_hard_calls, speech_free,
)
from vbench.block_text import render_input, speech_lines
from vbench.validate import input_text_errors, record_errors

LABEL = {
    "schema": "vbench.agent_label/1", "sample_id": "p3-src", "input_sha256": "a" * 64,
    "seats": {str(s): {"role": r, "side": sd, "verification": "verified"} for s, r, sd in [
        (1, "loyal", "good"), (2, "loyal", "good"), (3, "oberon", "evil"), (4, "percival", "good"),
        (5, "loyal", "good"), (6, "merlin", "good"), (7, "loyal", "good"), (8, "morgana", "evil"),
        (9, "mordred", "evil"), (10, "assassin", "evil")]},
    "role_enum": ["assassin", "loyal", "merlin", "minion", "mordred", "morgana", "oberon", "percival"],
    "side_enum": ["good", "evil"],
    "optional_targets": {"assassin_seat": 10, "assassination_hit": None,
                         "assassination_target_seat": None, "winning_side": None},
    "scoring": {"mode": "full", "primary": "seat_roles", "total_seats": 10, "verified_seats": 10},
    "notes": ["t"], "draft": False,
}


@pytest.fixture
def docs():
    utts, events = game()
    _, doc, full, _ = build(utts, events)
    return doc, full, objective_only_text(doc, like=full)


# ── what B must drop ───────────────────────────────────────────────────────


def test_b_carries_no_player_speech_at_all(docs):
    _, full, obj = docs
    assert speech_lines(full)                 # the control condition has speech
    assert speech_free(obj)
    assert "说话人未知" not in obj


def test_b_never_claims_that_nobody_spoke(docs):
    """Withheld by an experiment and absent from the record are different claims."""
    _, _, obj = docs
    for wording in ("发言：未记录", "发言：部分未记录", "本段未见玩家发言",
                    "无人发言", "没有人发言", "所有人都没说话", "未见"):
        assert wording not in obj


def test_b_drops_the_speech_explainer_but_still_says_what_it_holds(docs):
    _, full, obj = docs
    assert "先是该次组队讨论中的玩家原话" in full
    assert "先是该次组队讨论中的玩家原话" not in obj
    assert "以下按每次组队分段，列出这次组队的客观结果。" in obj


# ── what B must not touch ──────────────────────────────────────────────────


def test_every_objective_line_is_identical_and_in_the_same_order(docs):
    _, full, obj = docs
    assert objective_lines(full) == objective_lines(obj)
    assert objective_lines(obj), "fixture produced no objective lines"


def test_the_header_is_byte_identical_apart_from_the_explainer(docs):
    _, full, obj = docs
    head = lambda t: [l for l in t.split("以下按每次组队分段")[0].splitlines() if l]
    assert head(full) == head(obj)


def test_a_reordered_composition_would_have_been_caught(docs):
    """blocks.json is written with sorted keys, so re-rendering reorders this line."""
    doc, full, _ = docs
    shuffled = copy.deepcopy(doc)
    shuffled["rules"]["role_composition"] = dict(sorted(doc["rules"]["role_composition"].items()))
    naive = render_input(shuffled, speech=False)
    restored = objective_only_text(shuffled, like=full)
    line = lambda t: next(l for l in t.splitlines() if l.startswith("身份构成："))
    assert line(naive) != line(full)          # the bug this guards against
    assert line(restored) == line(full)       # and the guard works


def test_composition_order_reads_the_order_off_a_document(docs):
    _, full, _ = docs
    assert composition_order(full)[:2] == ["merlin", "percival"]
    assert composition_order("no such line") == []


def test_b_is_shorter_only_because_speech_left(docs):
    _, full, obj = docs
    assert len(obj) < len(full)
    assert len(obj.splitlines()) == len(full.splitlines()) - len(speech_lines(full)) - _blank_delta(full, obj)


def _blank_delta(full, obj):
    return len([l for l in full.splitlines() if not l]) - len([l for l in obj.splitlines() if not l])


def test_b_passes_the_same_forbidden_pattern_checks(docs):
    _, _, obj = docs
    assert not input_text_errors(obj)


# ── the label follows the truth, not the input ─────────────────────────────


def test_a_derived_label_keeps_the_seats_and_rebinds_the_hash():
    d = derive_label(LABEL, sample_id="abl-x", input_sha256="b" * 64, condition="objective_only")
    assert d["seats"] == LABEL["seats"]
    assert d["scoring"] == LABEL["scoring"] and d["optional_targets"] == LABEL["optional_targets"]
    assert d["input_sha256"] == "b" * 64 and d["sample_id"] == "abl-x"
    assert d["derived_from"] == {"sample_id": "p3-src", "input_sha256": "a" * 64,
                                 "condition": "objective_only"}
    assert not record_errors(d, "agent_label")


def test_deriving_a_label_does_not_touch_the_source():
    before = json.dumps(LABEL, sort_keys=True)
    derive_label(LABEL, sample_id="abl-x", input_sha256="b" * 64, condition="objective_only")
    assert json.dumps(LABEL, sort_keys=True) == before


def test_the_derived_id_differs_from_its_source_and_between_conditions():
    a = derived_sample_id("p3-src", "objective_only")
    b = derived_sample_id("p3-src", "something_else")
    assert a != "p3-src" and a != b and a.startswith("abl-")


def test_the_ablation_builder_takes_nothing_that_could_carry_an_answer():
    import inspect

    assert set(inspect.signature(objective_only_text).parameters) == {"blocks_doc", "like"}
    body = inspect.getsource(objective_only_text).split('"""')[-1]   # code, not the docstring
    for word in ("label", "roster", "private", "seats["):
        assert word not in body


# ── free baselines ─────────────────────────────────────────────────────────


def test_all_good_baseline_scores_only_side():
    res = score_hard_calls(baseline_all_good(list(range(1, 11))), LABEL)
    assert res["side_accuracy"] == 0.6 and res["side_correct"] == 6
    assert res["brier_score"] is None, "a rule that gives no probability gets no Brier"


def test_last_vote_baseline_uses_the_last_proposal_that_actually_voted(docs):
    doc, _, _ = docs
    out = baseline_last_vote(doc)
    assert out["available"]
    voted = [b for b in doc["blocks"] if b.get("votes")]
    assert (out["from_block"]["mission"], out["from_block"]["attempt"]) == (voted[-1]["mission"], voted[-1]["attempt"])
    assert out["from_block"]["mission"] <= doc["blocks"][-1]["mission"], "must not read past the cutoff"


def test_a_forced_round_is_skipped_because_it_carries_no_vote(docs):
    doc, _, _ = docs
    forced = [b for b in doc["blocks"] if b["forced"]]
    assert forced and all(b.get("votes") is None for b in forced)
    out = baseline_last_vote(doc)
    assert not (out["from_block"]["mission"] == forced[-1]["mission"]
                and out["from_block"]["attempt"] == forced[-1]["attempt"])


def test_seats_without_a_vote_are_reported_uncovered_not_guessed():
    doc = {"blocks": [{"mission": 1, "attempt": 1, "leader_seat": 2, "forced": False, "tally_text": "2:3",
                       "votes": {"approve": [1, 2], "reject": [3, 4, 5], "unclear": [6], "unrecorded": [7]}}]}
    out = baseline_last_vote(doc)
    assert out["uncovered_seats"] == [6, 7, 8, 9, 10]
    assert out["unclear"] == [6] and out["unrecorded"] == [7]
    res = score_hard_calls({int(k): v for k, v in out["calls"].items()}, LABEL)
    assert res["scored_seats"] == 5
    assert [r["reason"] for r in res["per_seat"] if not r["scored"]].count(
        "baseline makes no call for this seat") == 5


def test_no_vote_anywhere_reports_unavailable_rather_than_inventing_one():
    out = baseline_last_vote({"blocks": [{"mission": 1, "attempt": 1, "forced": True, "votes": None,
                                          "leader_seat": 1, "tally_text": None}]})
    assert out["available"] is False and out["reason"]
