"""Revision r1 of the input generator: coverage, unverified rules, empty speech.

Every test here is about a claim the *text* makes. The bugs they pin down all
had the same shape — the document stated as observed fact something that came
from a config default, from a later part of the video, or from the absence of a
record — so each one asserts on the rendered string, not on the data behind it.
"""

import copy
import inspect
import json
from pathlib import Path

import pytest
from synth import SOURCE, pilot_cfg, write_layout
from test_agent_blocks import build, game, mout, section

from vbench.agent_pairs import assumed_rules, build_agent_pairs, sample_id_v3
from vbench.api_trial import build_request, instruction_text
from vbench.block_text import blocks_document, coverage_line, render_input
from vbench.blocks import build_blocks
from vbench.timeline import TurnConfig, assemble, select_atoms
from vbench.util import sha256_bytes

THREE_ROUND_RULES = {
    "player_count": 10, "mission_team_sizes": [3, 4, 4], "proposal_limit": 3,
    "final_proposal_forced": True, "fails_required": [1, 1, 1],
    "lady_of_the_lake": {"observed": True},
    "role_composition": {"merlin": 1, "percival": 1, "loyal": 4, "morgana": 1, "mordred": 1,
                         "assassin": 1, "oberon": 1},
    "unverified": ["fails_required"],
    "basis": {"fails_required": "not shown by this client; 1/1/1 is the standard rule and is NOT observed here."},
}


def render(rules, cutoff=None, utts=None, events=None):
    u, e = game()
    atoms, _ = select_atoms(utts if utts is not None else u, events if events is not None else e, "accepted", None)
    t_cut = None
    if cutoff is not None:
        t_cut = {a["seq"]: a for a in atoms}[cutoff]["public_at"]
        atoms = [a for a in atoms if a["seq"] <= cutoff and a["public_at"] <= t_cut + 1e-9]
    items, _ = assemble(atoms, [], {}, [], TurnConfig(max_gap_s=4.0, review_pause_s=1.5), {}, until_public_at=t_cut)
    blocks, _ = build_blocks(items, rules)
    doc = blocks_document(blocks, rules)
    return doc, render_input(doc)


def head_of(text):
    return text.split("以下按每次组队分段")[0]


# -- 1. coverage comes from the blocks, never from the rule list --


def test_three_mission_sizes_but_a_record_that_stops_in_mission_two():
    """The exact game-2 bug: len(mission_team_sizes) was read as "rounds covered".

    Mission 3's size is on the client panel from the start, so stating it is
    fine; claiming the record reaches mission 3 is not.
    """
    doc, text = render(THREE_ROUND_RULES, cutoff=29)
    assert doc["blocks"][-1]["mission"] == 2
    assert "本记录到第 2 轮任务结束为止。" in text
    assert "第 3 轮" not in head_of(text)
    assert "本记录只到第 3 轮" not in text
    # the sizes themselves are still stated, as a claim about the record only
    assert "每轮任务人数依次为 3、4、4（记录中只出现过前 3 轮的人数）" in text


def test_coverage_names_the_open_proposal_when_the_last_mission_has_no_result():
    doc, text = render(THREE_ROUND_RULES)
    last = doc["blocks"][-1]
    assert (last["mission"], last["attempt"]) == (3, 3) and last["mission_result"] is None
    assert "本记录到第 3 轮第 3 次组队为止。" in text
    assert "任务结束为止" not in text


def test_coverage_line_is_none_for_an_empty_document():
    assert coverage_line([]) is None


def test_five_round_rules_state_no_size_caveat():
    rules = dict(THREE_ROUND_RULES, mission_team_sizes=[3, 4, 4, 5, 5], fails_required=[1, 1, 1, 2, 1])
    _, text = render(rules)
    assert "记录中只出现过前" not in text


# -- 2. a cutoff never inherits the full record's reach --


@pytest.mark.parametrize("cutoff_seq, expected", [
    (8, "本记录到第 1 轮第 1 次组队为止。"),
    (20, "本记录到第 1 轮任务结束为止。"),
    (28, "本记录到第 2 轮第 1 次组队为止。"),
    (29, "本记录到第 2 轮任务结束为止。"),
])
def test_a_cutoff_states_only_its_own_reach(cutoff_seq, expected):
    _, text = render(THREE_ROUND_RULES, cutoff=cutoff_seq)
    assert expected in text
    reached = int(expected.split("第 ")[1].split(" ")[0])
    for later in range(reached + 1, 6):
        assert f"本记录到第 {later} " not in text


def test_full_and_cutoff_disagree_about_coverage_and_that_is_the_point():
    _, full = render(THREE_ROUND_RULES)
    _, early = render(THREE_ROUND_RULES, cutoff=8)
    assert "本记录到第 3 轮第 3 次组队为止。" in full
    assert "本记录到第 3 轮第 3 次组队为止。" not in early


# -- 3. an unverified rule is not asserted to the model --


def test_an_unverified_rule_is_omitted_from_the_text_but_kept_for_the_checks():
    doc, text = render(THREE_ROUND_RULES)
    assert doc["rules_unverified"] == ["fails_required"]
    # dropped from what the model reads ...
    assert "失败牌数" not in text
    assert "各轮任务判定失败所需" not in text
    # ... but still present for validate.py's mission-result checks
    assert doc["rules"]["fails_required"] == [1, 1, 1]


def test_the_same_rule_is_stated_when_it_was_actually_observed():
    rules = dict(THREE_ROUND_RULES, unverified=[])
    _, text = render(rules)
    assert "各轮任务判定失败所需的失败牌数依次为 1、1、1" in text


def test_an_observed_fail_count_of_zero_survives_the_rule_being_dropped():
    """Dropping the rule sentence must not touch observed mission facts."""
    _, text = render(THREE_ROUND_RULES)
    body = section(text, "第1轮任务 · 第3次组队（强制轮）")
    assert "任务结果：成功" in body and "失败牌：0" in body


def test_assumed_rules_carry_their_basis_for_the_audit():
    rows = assumed_rules(THREE_ROUND_RULES)
    assert [r["key"] for r in rows] == ["fails_required"]
    assert rows[0]["value"] == [1, 1, 1] and rows[0]["omitted_from_input"] is True
    assert "NOT observed" in rows[0]["basis"]
    # a config that forgot to write a basis still produces a non-empty string
    assert assumed_rules({"unverified": ["fails_required"], "fails_required": [1]})[0]["basis"]


# -- 4. "not seen" and "not recorded" stay different claims --


def test_empty_and_cut_are_different_sentences():
    u, e = game()
    u = [x for x in u if x["utterance_id"] != "utt-%016x" % 18]
    _, _, empty_text, _ = build(u, e)
    cut = {"gaps": [{"gap_id": "cut", "kind": "edit_cut", "start": 17.0, "end": 21.0, "description": "剪辑缺口",
                     "omitted": ["讨论"], "late_reported_event_keys": [], "evidence": []}]}
    _, _, cut_text, _ = build(u, e, coverage=cut)
    heading = "第1轮任务 · 第3次组队（强制轮）"
    assert "发言：本段未见玩家发言" in section(empty_text, heading)
    assert "发言：未记录" in section(cut_text, heading)
    assert "发言：未记录" not in section(empty_text, heading)
    assert "发言：本段未见玩家发言" not in section(cut_text, heading)


def test_no_block_ever_claims_that_nobody_spoke():
    u, e = game()
    for variant in (u, [x for x in u if x["utterance_id"] != "utt-%016x" % 18]):
        _, _, text, _ = build(variant, e)
        for claim in ("所有人都没说话", "无人发言", "没有人发言", "全程沉默"):
            assert claim not in text


# -- 5. the label hash is the hash of the bytes actually written --


def test_label_hash_matches_the_input_file_bytes(tmp_path):
    out = _pairs(tmp_path, revision="r1")
    root = Path(out["out_dir"])
    assert out["pairs"]
    for p in out["pairs"]:
        raw = (root / p["input_path"]).read_bytes()
        label = json.loads((root / p["label_path"]).read_text(encoding="utf-8"))
        assert sha256_bytes(raw) == p["input_sha256"] == label["input_sha256"]


def test_a_revision_gets_new_sample_ids_and_a_map_back(tmp_path):
    base = _pairs(tmp_path, revision="")
    rev = _pairs(tmp_path, revision="r1", fresh=False)
    assert base["out_dir"] != rev["out_dir"] and rev["out_dir"].endswith("agent_pairs_v3_r1")
    old_ids = {p["sample_id"] for p in base["pairs"]}
    new_ids = {p["sample_id"] for p in rev["pairs"]}
    assert not (old_ids & new_ids)
    man = json.loads((Path(rev["out_dir"]) / "manifest.json").read_text(encoding="utf-8"))
    rows = man["revision_of"]["sample_id_map"]
    assert {r["old_sample_id"] for r in rows} == old_ids
    assert {r["new_sample_id"] for r in rows} == new_ids
    assert all(r["old_input_sha256"] for r in rows)


def test_sample_id_without_a_revision_is_unchanged():
    """Game 1's exported ids must not move because r1 exists."""
    args = ("game-0123456789", "game2-v1", "accepted", "public_observer", None)
    assert sample_id_v3(*args) == sample_id_v3(*args, "")
    assert sample_id_v3(*args) != sample_id_v3(*args, "r1")


# -- 6. nothing answer-bearing can reach the request --


def test_the_request_carries_only_the_instruction_and_the_document(tmp_path):
    out = _pairs(tmp_path, revision="r1")
    root = Path(out["out_dir"])
    full = next(p for p in out["pairs"] if p["kind"] == "full")
    text = (root / full["input_path"]).read_text(encoding="utf-8")
    label = json.loads((root / full["label_path"]).read_text(encoding="utf-8"))
    req = build_request(game_text=text, instruction=instruction_text(), model="m",
                        max_output_tokens=16000, reasoning_effort="high")
    blob = json.dumps(req, ensure_ascii=False)
    assert len(req["input"]) == 2 and req["input"][1]["content"] == text
    for seat, truth in label["seats"].items():
        assert '"%s": "%s"' % (seat, truth["role"]) not in blob
    # role names in English exist only in the instruction's enum and the output
    # schema — the document the model reads carries none of them
    for role in ("mordred", "percival", "morgana", "oberon", "assassin", "merlin", "loyal"):
        assert role not in text
        assert blob.count(role) == 2
    for k in ("assassination_hit", "assassination_target_seat", "winning_side", "input_sha256", "verification"):
        assert k not in blob
    assert "刺杀" not in blob and "阵营获胜" not in blob


def test_build_request_has_no_parameter_that_could_carry_a_label():
    names = set(inspect.signature(build_request).parameters)
    assert names == {"game_text", "instruction", "model", "max_output_tokens", "reasoning_effort"}


# -- 7. a player's own role claim is evidence, not a leak --


def test_role_words_inside_original_speech_are_never_stripped():
    u, e = game()
    u[1]["caption"]["text"] = "我不是派西维尔 我是梅林"
    u[1]["asr"]["text"] = "我不是派西维尔 我是梅林"
    _, _, text, _ = build(u, e)
    assert "我不是派西维尔 我是梅林" in text


# -- 8. exporting more of the video later cannot change an exported cutoff --


def test_appending_later_events_leaves_an_earlier_cutoff_byte_identical():
    u, e = game()
    _, before = render(THREE_ROUND_RULES, cutoff=20, utts=u, events=e)
    later_events = copy.deepcopy(e) + [mout(39, 3, "fail", 1, 62.0)]
    later_utts = u + [dict(copy.deepcopy(u[-1]), utterance_id="utt-%016x" % 40, sequence=40)]
    _, after = render(THREE_ROUND_RULES, cutoff=20, utts=later_utts, events=later_events)
    assert before == after


def _pairs(tmp_path, revision: str, fresh: bool = True):
    from vbench.paths import annotation_paths, run_paths
    from vbench.source import save_manifest
    from vbench.util import write_json, write_jsonl

    utts, events = game()
    tmp_path.mkdir(parents=True, exist_ok=True)
    cfg = pilot_cfg(write_layout(tmp_path), run_id="r1run", cutoffs=[
        {"label": "m1 attempt 1 vote outcome",
         "after": {"event": {"type": "vote_outcome", "mission": 1, "proposal_index": 1}}},
    ])
    cfg["interval"] = {"start": 0, "end": 100}
    cfg["rules"] = dict(THREE_ROUND_RULES)
    run = run_paths(cfg["run_id"])
    if fresh:
        write_jsonl(run.views / "all" / "utterances.jsonl", utts)
        write_jsonl(run.views / "all" / "events.jsonl", events)
        write_jsonl(run.public / "speaker_segments.jsonl", [])
        save_manifest({"schema": "vbench.evaluator_manifest/1", "games": [
            {"game_id": SOURCE["game_id"], "group_id": "grp-synth", "split": "dev",
             "source": {"source_id": SOURCE["source_id"], "video_sha256": SOURCE["video_sha256"],
                        "audio_sha256": None}}], "samples": []})
        roles = {1: "loyal", 2: "loyal", 3: "oberon", 4: "percival", 5: "loyal", 6: "merlin",
                 7: "loyal", 8: "morgana", 9: "mordred", 10: "assassin"}
        side = {"loyal": "good", "percival": "good", "merlin": "good"}
        write_json(annotation_paths(SOURCE["source_id"]).root / "private" / "roster_v2.json", {
            "schema": "vbench.private_roster/2", "game_id": SOURCE["game_id"], "player_count": 10,
            "composition": THREE_ROUND_RULES["role_composition"],
            "seats": [{"seat": s, "role": r, "side": side.get(r, "evil"), "verification": "verified",
                       "sources": [{"kind": "roster_crop"}], "consistency": {"checked_times": [1.0], "agree": True}}
                      for s, r in roles.items()],
            "end_of_video_reveal": {"available": False, "note": "t"}, "notes": []})
    return build_agent_pairs(cfg, SOURCE, "accepted", revision=revision,
                             revision_reason=["测试用"] if revision else None)
