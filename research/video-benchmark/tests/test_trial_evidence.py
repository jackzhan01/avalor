"""The evidence checker: what it can settle, and what it must refuse to settle."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from check_trial_evidence import evaluate  # noqa: E402

BLOCKS = [
    {"mission": 1, "attempt": 1, "leader_seat": 2, "team_seats": [7, 8, 9], "forced": False,
     "votes": {"approve": [2, 8, 10], "reject": [1, 3, 4, 5, 6, 7, 9], "unclear": [], "unrecorded": []},
     "tally_text": "3:7", "outcome": "rejected", "mission_ran": False, "mission_result": None, "fail_count": None},
    {"mission": 1, "attempt": 2, "leader_seat": 3, "team_seats": [3, 7, 9], "forced": False,
     "votes": {"approve": [1, 2, 3, 7, 8, 9, 10], "reject": [4, 5, 6], "unclear": [], "unrecorded": []},
     "tally_text": None, "outcome": "passed", "mission_ran": True, "mission_result": "success", "fail_count": 0},
]
TEXT = "7号：直接加8吧\n车主：5号\n7号：你就开那个3789\n车主：6号\n"


def verdicts(claims):
    return [r["verified"] for r in evaluate(claims, BLOCKS, TEXT)]


def test_objective_claims_are_settled_from_the_blocks():
    assert verdicts([
        {"kind": "leader_is", "claim": "", "mission": 1, "attempt": 1, "seat": 2},
        {"kind": "team_is", "claim": "", "mission": 1, "attempt": 1, "seats": [7, 8, 9]},
        {"kind": "rejected", "claim": "", "mission": 1, "attempt": 1, "seat": 1},
        {"kind": "approved", "claim": "", "mission": 1, "attempt": 1, "seat": 1},
        {"kind": "fail_count_is", "claim": "", "mission": 1, "attempt": 2, "count": 0},
        {"kind": "not_in_team", "claim": "", "mission": 1, "attempt": 2, "seat": 4},
    ]) == [True, True, True, False, True, True]


def test_a_claim_about_a_round_that_is_not_in_the_record_fails_rather_than_passes():
    assert verdicts([{"kind": "leader_is", "claim": "", "mission": 9, "attempt": 1, "seat": 2}]) == [False]


def test_quotes_are_matched_byte_for_byte():
    assert verdicts([{"kind": "quote", "claim": "", "quote": "直接加8吧"},
                     {"kind": "quote", "claim": "", "quote": "直接加七吧"}]) == [True, False]


def test_quote_before_catches_a_line_that_only_appears_later():
    """The game-3 finding: the model said seat 5 ignored a team seat 7 had named,
    but '3789' is first said after seat 5's proposal, so it cannot be what 5 ignored."""
    assert verdicts([
        {"kind": "quote_before", "claim": "", "quote": "3789", "anchor": "车主：5号"},
        {"kind": "quote_before", "claim": "", "quote": "3789", "anchor": "车主：6号"},
        {"kind": "quote_before", "claim": "", "quote": "从未说过", "anchor": "车主：6号"},
    ]) == [False, True, False]


def test_reading_intent_is_never_reported_as_a_pass():
    rows = evaluate([{"kind": "undecidable", "claim": "持续偏站9号", "reason": "读意图"}], BLOCKS, TEXT)
    assert rows[0]["verified"] is None and rows[0]["reason"] == "读意图"


def test_undecidable_rows_are_kept_out_of_both_tallies():
    import json
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        t = Path(d)
        (t / "input.zh.txt").write_text(TEXT, encoding="utf-8")
        (t / "blocks.json").write_text(json.dumps({"blocks": BLOCKS}), encoding="utf-8")
        (t / "claims.json").write_text(json.dumps({"claims": [
            {"kind": "quote", "claim": "a", "quote": "直接加8吧"},
            {"kind": "leader_is", "claim": "b", "mission": 1, "attempt": 1, "seat": 2},
            {"kind": "undecidable", "claim": "c", "reason": "读意图"},
        ]}, ensure_ascii=False), encoding="utf-8")
        subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "scripts" / "check_trial_evidence.py"),
                        str(t), str(t / "blocks.json"), str(t / "claims.json")],
                       check=True, capture_output=True)
        rep = json.loads((t / "evidence_check.json").read_text(encoding="utf-8"))
    assert rep["factual_total"] == 1 and rep["quotes_total"] == 1 and len(rep["undecidable"]) == 1
