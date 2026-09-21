"""Agent-pair revision: per-proposal blocks, the input document, and its label file."""

import copy
import json
from pathlib import Path

import pytest
from synth import SOURCE, pilot_cfg, write_layout
from test_corrections_ledger import board_event, utt

from vbench.agent_pairs import build_agent_pairs, build_document, excluded_records, load_pair, sample_id_v3
from vbench.block_text import blocks_document, render_input, speech_lines
from vbench.blocks import block_accounting, build_blocks
from vbench.timeline import TurnConfig, assemble, select_atoms
from vbench.validate import agent_blocks_errors, input_text_errors, record_errors

RULES = pilot_cfg(Path("x"))["rules"]
TCFG = TurnConfig(max_gap_s=4.0, review_pause_s=1.5)


def seg(n, text, start, end, seat, status="accepted", **kw):
    u = utt(f"utt-{n:016x}", text, start, end, seat=seat)
    u.update(sequence=n, ordering={"status": "in_sequence"}, review_status=status, origin="machine", applied_corrections=[])
    u.update(kw)
    return u


def ev(n, etype, payload, public_at, status="accepted"):
    e = board_event(f"evt-{n:016x}", etype)
    e.update(payload=payload, sequence=n, ordering={"status": "in_sequence"}, review_status=status, stable_key=f"board:{n}:{etype}")
    e["availability"] = {"status": "anchored", "public_at": public_at, "basis": "reveal", "evidence_refs": [{"kind": "video_moment", "id": "r", "video_time": public_at}]}
    return e


def ts(n, m, a, leader, team, at, forced=False):
    return ev(n, "team_selection", {"mission": m, "proposal_index": a, "leader_seat": leader, "team_seats": team, "forced": forced}, at)


def vobs(n, m, a, votes, at):
    return ev(n, "vote_observation", {"mission": m, "proposal_index": a, "votes": votes}, at)


def vout(n, m, a, result, at, tally=None):
    return ev(n, "vote_outcome", {"mission": m, "proposal_index": a, "result": result, "tally_text": tally, "explicit": True}, at)


def mout(n, m, result, fails, at):
    return ev(n, "mission_outcome", {"mission": m, "result": result, "fail_count": fails}, at)


ALL_REJECT = {str(s): "reject" for s in range(1, 11)}


def game():
    """Two attempts on mission 1 (both rejected), a forced third that succeeds,
    mission 2 passes and fails, then mission 3 stalls on its forced team."""
    utts = [
        seg(1, "好那从这边发言", 0.0, 1.3, 10),
        seg(2, "我不是派西", 1.3, 2.2, 1),
        seg(3, "先过吧", 2.3, 3.0, 1),
        seg(4, "我就发一个3", 3.1, 4.0, 10),
        seg(5, "4带上我自己好吧", 4.0, 5.0, 10),
        # after the first rejection: A -> B -> A with an unknown speaker in between
        seg(9, "那从十号发言", 11.0, 12.0, 1),
        seg(10, "我不听", 12.0, 12.6, None, eligibility="in_game_speech"),
        seg(11, "哈哈那你点吧", 12.6, 13.4, 1),
        seg(12, "我插一句", 13.4, 14.0, 2),
        seg(13, "我发147", 14.0, 15.0, 1),
        # forced round of mission 1: short real exchange, then the cut
        seg(18, "你点吧我直接开车", 21.0, 22.0, 1),
        # mission 2 discussion
        seg(23, "我先点个车3457", 31.0, 32.0, 3),
        seg(26, "我上车", 36.0, 37.0, 5),
        # mission 3: two rejected attempts, then the forced team the upload stops on
        seg(31, "这轮我来开", 51.0, 52.0, 7),
        seg(34, "我不同意", 55.0, 56.0, 8),
        seg(37, "那就必做轮吧", 59.0, 60.0, 9),
    ]
    utts[6]["speaker"]["attribution"] = "no_label"
    events = [
        ts(6, 1, 1, 10, [3, 4, 10], 5.0),
        vobs(7, 1, 1, ALL_REJECT, 6.0),
        vout(8, 1, 1, "rejected", 6.0, "0:10"),
        ts(14, 1, 2, 1, [1, 4, 7], 15.0),
        vobs(15, 1, 2, {**ALL_REJECT, "1": "approve", "4": "approve", "9": "unknown"}, 16.0),
        vout(16, 1, 2, "rejected", 16.0, "2:7"),
        ts(19, 1, 3, 2, [2, 4, 6], 23.0, forced=True),
        mout(20, 1, "success", 0, 24.0),
        ts(24, 2, 1, 3, [3, 4, 5, 7], 33.0),
        vobs(27, 2, 1, {**ALL_REJECT, "3": "approve", "4": "approve", "5": "approve", "7": "approve", "10": "approve", "6": "approve"}, 38.0),
        vout(28, 2, 1, "passed", 38.0, "6:4"),
        mout(29, 2, "fail", None, 39.0),
        ts(32, 3, 1, 7, [1, 3, 5, 7, 9], 53.0),
        vout(33, 3, 1, "rejected", 54.0, "4:6"),
        ts(35, 3, 2, 8, [2, 4, 5, 8, 9], 57.0),
        vout(36, 3, 2, "rejected", 58.0, "3:7"),
        ts(38, 3, 3, 9, [1, 2, 5, 8, 9], 61.0, forced=True),
    ]
    return utts, events


def build(utts, events, cutoff=None, dataset="accepted", coverage=None, decisions=()):
    live = (coverage or {}).get("live_game_interval")
    atoms, _ = select_atoms(utts, events, dataset, live[1] if live else None)
    gaps = list((coverage or {}).get("gaps", []))
    t_cut = None
    if cutoff is not None:
        t_cut = {a["seq"]: a for a in atoms}[cutoff]["public_at"]
        atoms = [a for a in atoms if a["seq"] <= cutoff and a["public_at"] <= t_cut + 1e-9]
        gaps = [g for g in gaps if g["start"] <= t_cut]
    late = {k: g["gap_id"] for g in gaps for k in g["late_reported_event_keys"]}
    items, _ = assemble(atoms, gaps, {}, list(decisions), TCFG, late, until_public_at=t_cut)
    blocks, stats = build_blocks(items, RULES)
    assert not block_accounting(blocks, items), block_accounting(blocks, items)
    doc = blocks_document(blocks, RULES)
    assert not record_errors(doc, "agent_blocks"), record_errors(doc, "agent_blocks")
    return blocks, doc, render_input(doc), items


def block_of(doc, bid):
    return next(b for b in doc["blocks"] if b["block_id"] == bid)


def section(text, heading):
    """The lines of one block, from its heading to the next blank-line heading."""
    lines = text.splitlines()
    i = lines.index(heading)
    out = []
    for line in lines[i + 1 :]:
        if line.startswith("第") and "组队" in line:
            break
        out.append(line)
    return [x for x in out if x]


# ── 1. a normal proposal keeps its own speech, leader, team, tally and result ──


def test_one_normal_proposal_carries_its_speech_leader_team_votes_and_result():
    _, doc, text, _ = build(*game())
    b = block_of(doc, "b1-1")
    assert [(p["seat"], p["text"]) for p in b["speech"]] == [
        (10, "好那从这边发言"), (1, "我不是派西 先过吧"), (10, "我就发一个3 4带上我自己好吧")]
    assert (b["leader_seat"], b["team_seats"], b["outcome"]) == (10, [3, 4, 10], "rejected")
    assert b["votes"]["reject"] == list(range(1, 11)) and b["votes"]["approve"] == []
    assert section(text, "第1轮任务 · 第1次组队")[-5:] == [
        "车主：10号", "车队：3、4、10", "上票：无", "下票：1、2、3、4、5、6、7、8、9、10", "组队结果：车被否（0:10）"]


# ── 2. a rejected team has no mission, and the round number does not advance ──


def test_a_rejected_team_has_no_mission_result_and_the_next_attempt_stays_in_the_same_mission():
    _, doc, text, _ = build(*game())
    ids = [b["block_id"] for b in doc["blocks"]]
    assert ids == ["b1-1", "b1-2", "b1-3", "b2-1", "b3-1", "b3-2", "b3-3"]
    for bid in ("b1-1", "b1-2"):
        b = block_of(doc, bid)
        assert b["mission_ran"] is False and b["mission_result"] is None
    assert "任务结果" not in "\n".join(section(text, "第1轮任务 · 第1次组队"))
    # mission 2 is only reached after mission 1 actually resolves
    assert block_of(doc, "b1-3")["mission_result"] == "success"


# ── 3. a forced round: no invented tally, real short talk is kept ──


def test_forced_round_states_that_no_vote_is_taken_and_keeps_the_speech_it_really_had():
    _, doc, text, _ = build(*game())
    b = block_of(doc, "b1-3")
    assert b["forced"] is True and b["votes"] is None and b["outcome"] is None and b["tally_text"] is None
    assert [p["text"] for p in b["speech"]] == ["你点吧我直接开车"]
    body = section(text, "第1轮任务 · 第3次组队（强制轮）")
    assert "1号：你点吧我直接开车" in body
    assert "投票：无需投票，强制执行" in body
    assert not any(x.startswith(("上票", "下票", "组队结果")) for x in body)
    # the previous attempt's rejections are not carried over
    assert "2:7" not in "\n".join(body)


def test_a_forced_round_with_no_recorded_talk_says_none_was_seen_not_that_none_happened():
    """No caption and no accepted record is an absence of observation.

    The block used to render with no speech section at all, which reads as
    "nobody spoke". It now says so in the weaker wording, and stays distinct
    from the edit-cut wording tested below.
    """
    utts, events = game()
    utts = [u for u in utts if u["utterance_id"] != f"utt-{18:016x}"]
    _, doc, text, _ = build(utts, events)
    b = block_of(doc, "b1-3")
    assert b["speech"] == [] and b["speech_recorded"] == "empty"
    body = section(text, "第1轮任务 · 第3次组队（强制轮）")
    assert body[0] == "发言：本段未见玩家发言"
    assert not speech_lines(chr(10).join(body))
    assert "未记录" not in body[0]
    for claim in ("所有人都没说话", "无人发言", "没有人发言"):
        assert claim not in text


def test_a_round_whose_talk_was_cut_says_so_instead_of_looking_empty():
    utts, events = game()
    utts = [u for u in utts if u["utterance_id"] != f"utt-{18:016x}"]
    coverage = {"gaps": [{"gap_id": "cut", "kind": "edit_cut", "start": 17.0, "end": 21.0, "description": "剪辑缺口",
                          "omitted": ["第3次组队的讨论"], "late_reported_event_keys": [], "evidence": []}]}
    _, doc, text, _ = build(utts, events, coverage=coverage)
    assert block_of(doc, "b1-3")["speech_recorded"] == "none"
    assert "发言：未记录" in section(text, "第1轮任务 · 第3次组队（强制轮）")
    # the archival gap description never travels with it
    assert "第3次组队的讨论" not in text


# ── 4. the last team of the upload has no result, and none is invented ──


def test_the_last_forced_team_has_no_mission_result_no_winner_and_no_assassination():
    _, doc, text, _ = build(*game())
    b = block_of(doc, "b3-3")
    assert b["forced"] is True
    assert b["mission_ran"] is True and b["mission_result"] is None and b["fail_count"] is None
    body = section(text, "第3轮任务 · 第3次组队（强制轮）")
    assert "任务结果：未记录" in body and not any(x.startswith("失败牌") for x in body)
    for word in ("胜", "获胜", "刺杀", "狼人赢"):
        assert word not in text


# ── 5. interjections, unknown speakers and A→B→A survive unmerged ──


def test_interjections_unknown_speakers_and_aba_are_neither_merged_nor_summarised():
    _, doc, text, _ = build(*game())
    said = [(p["seat"], p["text"]) for p in block_of(doc, "b1-2")["speech"]]
    assert said == [(1, "那从十号发言"), (None, "我不听"), (1, "哈哈那你点吧"), (2, "我插一句"), (1, "我发147")]
    assert ("说话人未知", "我不听") in speech_lines(text)
    # nothing is compressed away: every original string is present verbatim, once
    for _, t in said:
        assert text.count(t) == 1


def test_a_contribution_split_by_an_event_is_rejoined_but_never_across_speakers_or_blocks():
    """The board row lands mid-contribution: the timeline keeps two parts in
    place, the block shows one paragraph, and no word moves or doubles."""
    utts = [seg(1, "我发147", 0.0, 1.0, 1), seg(3, "7号跟4号给的吧", 1.0, 1.8, 1), seg(4, "我不同意", 2.0, 3.0, 2)]
    events = [ts(2, 1, 1, 1, [1, 4, 7], 1.0)]
    _, doc, text, items = build(utts, events)
    parts = [it for it in items if it["kind"] == "speech"]
    assert [(p["seat"], p["text"], p["continues_turn"]) for p in parts] == [
        (1, "我发147", False), (1, "7号跟4号给的吧", True), (2, "我不同意", False)]
    b = block_of(doc, "b1-1")
    assert b["speech"] == [{"seat": 1, "text": "我发147 7号跟4号给的吧"}, {"seat": 2, "text": "我不同意"}]
    assert text.count("7号跟4号给的吧") == 1 and text.count("我发147") == 1


# ── 6. accounting: every eligible caption once, every exclusion explained ──


def test_every_eligible_accepted_caption_appears_once_and_exclusions_are_listed_with_reasons(tmp_path):
    utts, events = game()
    utts[2]["review_status"] = "needs_review"
    utts.append(seg(40, "好狼人赢了", 71.0, 72.0, 8, eligibility="editorial"))
    utts.append(seg(41, "这条是重复显示", 72.0, 73.0, 8, status="rejected"))
    blocks, doc, text, items = build(utts, events)
    assert "先过吧" not in text and "好狼人赢了" not in text and "重复显示" not in text
    kept_seg = {s for b in blocks for p in b["speech"] for s in p["segment_ids"]}
    kept_ev = {e["event_id"] for b in blocks for e in b["audit"]["events"]}
    cfg = {"interval": {"start": 0, "end": 100}}
    excl = excluded_records({"utterances": utts, "events": events, "coverage": None}, cfg, "accepted", kept_seg, kept_ev)
    by_id = {i: r["reason"] for r in excl for i in r["ids"]}
    assert "资格为 editorial" in by_id[f"utt-{40:016x}"]
    assert "审阅拒绝" in by_id[f"utt-{41:016x}"]
    assert "不收未审阅候选" in by_id[f"utt-{3:016x}"]
    assert not any("原因未归类" in r["reason"] for r in excl)


# ── 7. missing vs unknown vs zero ──


def test_missing_tally_unreadable_seat_and_unknown_fail_count_all_read_differently():
    utts, events = game()
    _, doc, text, _ = build(utts, events)
    b = block_of(doc, "b1-2")
    assert b["votes"]["unclear"] == [9] and b["votes"]["approve"] == [1, 4]
    body = section(text, "第1轮任务 · 第2次组队")
    assert "看不清：9" in body and "未记录" not in "\n".join(x for x in body if x.startswith(("上票", "下票", "看不清")))
    # a mission that failed with an unreadable fail card is not written as 0
    assert block_of(doc, "b2-1")["fail_count"] is None
    assert "失败牌：未知" in section(text, "第2轮任务 · 第1次组队")

    # seats that were never observed, and a board result with no tally text
    events2 = [e for e in events if e["event_id"] != f"evt-{15:016x}"]
    events2.append(vobs(15, 1, 2, {"1": "approve", "2": "reject"}, 16.0))
    events2 = [vout(16, 1, 2, "rejected", 16.0) if e["event_id"] == f"evt-{16:016x}" else e for e in events2]
    _, doc2, text2, _ = build(utts, events2)
    assert block_of(doc2, "b1-2")["votes"]["unrecorded"] == [3, 4, 5, 6, 7, 8, 9, 10]
    assert "未记录：3、4、5、6、7、8、9、10" in section(text2, "第1轮任务 · 第2次组队")
    assert "组队结果：车被否" in section(text2, "第1轮任务 · 第2次组队")  # explicit result, no tally invented


def test_a_result_is_never_reconstructed_from_a_partial_tally():
    """Ten visible reject cards and no board result: the outcome stays unrecorded."""
    utts = [seg(1, "我发一个车", 0.0, 1.0, 10)]
    events = [ts(2, 1, 1, 10, [3, 4, 10], 1.0), vobs(3, 1, 1, ALL_REJECT, 2.0)]
    _, doc, text, _ = build(utts, events)
    b = block_of(doc, "b1-1")
    assert b["outcome"] is None and b["votes"]["reject"] == list(range(1, 11))
    body = section(text, "第1轮任务 · 第1次组队")
    assert "组队结果：未记录" in body
    assert "车被否" not in "\n".join(body) and "任务结果" not in "\n".join(body)


# ── 8. cutoffs ──


def test_a_cutoff_inside_a_block_shows_no_later_team_tally_or_result():
    utts, events = game()
    _, doc, text, _ = build(utts, events, cutoff=5)  # mid mission-1 discussion, before the board row
    assert [b["block_id"] for b in doc["blocks"]] == ["b1-1"]
    b = doc["blocks"][0]
    assert (b["leader_seat"], b["team_seats"], b["votes"], b["outcome"]) == (None, None, None, None)
    assert "车主" not in text and "上票" not in text and "任务结果" not in text
    assert "我就发一个3 4带上我自己好吧" in text


def test_a_late_board_row_reaches_its_own_block_but_not_an_earlier_cutoff():
    utts, events = game()
    coverage = {"gaps": [{"gap_id": "cut", "kind": "edit_cut", "start": 22.5, "end": 31.0, "description": "剪辑缺口",
                          "omitted": ["翻牌"], "late_reported_event_keys": [f"board:{19}:team_selection", f"board:{20}:mission_outcome"], "evidence": []}]}
    _, early, early_text, _ = build(utts, events, cutoff=18, coverage=coverage)
    assert [b["block_id"] for b in early["blocks"]] == ["b1-1", "b1-2", "b1-3"]
    assert block_of(early, "b1-3")["team_seats"] is None and "任务结果" not in early_text
    _, late, late_text, _ = build(utts, events, cutoff=20, coverage=coverage)
    lb = block_of(late, "b1-3")
    assert lb["team_seats"] == [2, 4, 6] and lb["mission_result"] == "success"
    assert "任务结果：成功" in late_text and "失败牌：0" in late_text


def test_cutoff_documents_are_the_full_document_truncated_not_reordered():
    utts, events = game()
    _, full, _, _ = build(utts, events)
    for cut in (8, 16, 20, 28):
        _, part, _, _ = build(utts, events, cutoff=cut)
        for b in part["blocks"][:-1]:
            assert b == block_of(full, b["block_id"]), (cut, b["block_id"])
        tail = part["blocks"][-1]
        ftail = block_of(full, tail["block_id"])
        assert tail["speech"] == ftail["speech"][: len(tail["speech"])]


def test_a_board_row_naming_an_attempt_nobody_opened_renumbers_the_block_and_says_so():
    """The edit dropped attempts 1-2 entirely; the board row is the only witness
    of which attempt this is, so the open block takes its number, loudly."""
    utts = [seg(1, "那就必做轮吧", 0.0, 1.0, 9)]
    events = [ts(2, 1, 3, 2, [2, 4, 6], 2.0, forced=True)]
    coverage = {"gaps": [{"gap_id": "cut", "kind": "edit_cut", "start": 1.5, "end": 1.9, "description": "剪辑缺口",
                          "omitted": ["前两次组队"], "late_reported_event_keys": [], "evidence": []}]}
    blocks, doc, text, _ = build(utts, events, coverage=coverage)
    assert [b["block_id"] for b in doc["blocks"]] == ["b1-3"]
    assert doc["blocks"][0]["forced"] is True and doc["blocks"][0]["speech_recorded"] == "partial"
    assert "第1轮任务 · 第3次组队（强制轮）" in text and "发言：部分未记录" in text
    conflict = blocks[0]["audit"]["conflicts"][0]
    assert conflict["board"] == [1, 3] and conflict["derived"] == [1, 1]
    assert "renumbered" in conflict["resolution"]


def test_the_leak_check_catches_audit_material_slipped_into_a_document():
    _, doc, text, _ = build(*game())
    assert not input_text_errors(text)
    for bad in ("1号：见 09:32.18 的字幕卡", "1号：utt-7c4b0861 说的", "1号：见 https://example.com"):
        assert input_text_errors(text + "\n" + bad)
    leaky = copy.deepcopy(doc)
    leaky["blocks"][0]["speech"][0]["text"] = "来源 bilibili 的片段"
    assert agent_blocks_errors(leaky)
    leaky2 = copy.deepcopy(doc)
    leaky2["blocks"][0]["mission_result"] = "success"  # rejected team with a result
    assert any("rejected team" in e for e in agent_blocks_errors(leaky2))


# ── 9. appending later material, or changing the answer, leaves inputs alone ──


def test_appending_future_speech_or_facts_does_not_change_an_earlier_input():
    utts, events = game()
    _, _, base, _ = build(utts[:5], events[:3], cutoff=5)
    _, _, longer, _ = build(utts, events, cutoff=5)
    assert base == longer
    _, _, before, _ = build(utts, events, cutoff=16)
    utts2 = utts + [seg(50, "后来又说了一句", 80.0, 81.0, 1)]
    events2 = events + [mout(51, 3, "fail", 2, 82.0)]
    _, _, after, _ = build(utts2, events2, cutoff=16)
    assert before == after


def test_changing_the_private_answer_leaves_every_input_byte_identical(tmp_path):
    outs = []
    for roles_variant in (0, 1):
        res = _run_pairs(tmp_path / f"v{roles_variant}", roles_variant)
        outs.append(res)
    inputs0 = {p["cutoff_label"]: p["input_sha256"] for p in outs[0]["pairs"]}
    inputs1 = {p["cutoff_label"]: p["input_sha256"] for p in outs[1]["pairs"]}
    assert inputs0 == inputs1
    assert {p["label_sha256"] for p in outs[0]["pairs"]} != {p["label_sha256"] for p in outs[1]["pairs"]}


# ── 10/11. what the document may contain, and what an evaluator sends ──


def test_input_has_no_source_ids_audit_fields_or_answers_but_keeps_spoken_role_words():
    utts, events = game()
    utts[1]["caption"]["text"] = "我是梅林啊 我不是派西"  # a player naming a role is speech, not a label
    _, doc, text, _ = build(utts, events)
    assert not input_text_errors(text, ["src-aaaaaaaaaaaa", "BV19D7565EZg", "圆桌谜局"])
    assert "我是梅林啊" in text
    assert not agent_blocks_errors(doc, ["src-aaaaaaaaaaaa"])
    for token in ("utt-", "evt-", "turn_id", "sequence", "review_status", "OCR", "ASR", "sha256", "剪辑缺口", "〔续〕"):
        assert token not in text
    assert not any(ch.isdigit() and ":" in line for line in text.splitlines() for ch in "" )  # no timecodes


def test_the_message_sent_to_the_api_is_exactly_the_file_and_the_label_is_a_separate_read(tmp_path):
    res = _run_pairs(tmp_path / "pair", 0)
    manifest = Path(res["manifest"])
    sid = next(p["sample_id"] for p in res["pairs"] if p["kind"] == "full")
    text, label = load_pair(manifest, sid)
    on_disk = (manifest.parent / "full" / "input.zh.txt").read_text(encoding="utf-8")
    messages = [{"role": "user", "content": text}]
    assert messages[0]["content"] == on_disk
    assert "role" not in text and label["seats"]["1"]["role"] not in text
    blob = json.dumps(messages, ensure_ascii=False)
    assert "sample_id" not in blob and "input_sha256" not in blob and "label" not in blob
    assert label["optional_targets"] == {"assassin_seat": 10, "assassination_target_seat": None,
                                         "assassination_hit": None, "winning_side": None}


# ── 12. determinism ──


def test_rebuilding_produces_identical_bytes_and_touches_no_evidence(tmp_path):
    first = _run_pairs(tmp_path / "det", 0)
    views = Path(first["out_dir"]).parent / "views" / "all" / "utterances.jsonl"
    before = views.read_bytes()
    second = _run_pairs(tmp_path / "det", 0, fresh=False)
    assert [(p["input_sha256"], p["label_sha256"]) for p in first["pairs"]] == [(p["input_sha256"], p["label_sha256"]) for p in second["pairs"]]
    assert views.read_bytes() == before


# ── helpers that need the data root ──


def _run_pairs(tmp_path, roles_variant: int, fresh: bool = True):
    from vbench.paths import annotation_paths, run_paths
    from vbench.source import save_manifest
    from vbench.util import write_json, write_jsonl

    utts, events = game()
    tmp_path.mkdir(parents=True, exist_ok=True)
    cfg = pilot_cfg(write_layout(tmp_path), run_id=f"ap{roles_variant}", cutoffs=[
        {"label": "m1 attempt 1 vote outcome", "after": {"event": {"type": "vote_outcome", "mission": 1, "proposal_index": 1}}},
        {"label": "m1 mission outcome", "after": {"event": {"type": "mission_outcome", "mission": 1}}},
    ])
    cfg["interval"] = {"start": 0, "end": 100}
    run = run_paths(cfg["run_id"])
    if fresh:
        write_jsonl(run.views / "all" / "utterances.jsonl", utts)
        write_jsonl(run.views / "all" / "events.jsonl", events)
        write_jsonl(run.public / "speaker_segments.jsonl", [])
        save_manifest({"schema": "vbench.evaluator_manifest/1", "games": [
            {"game_id": SOURCE["game_id"], "group_id": "grp-synth", "split": "dev",
             "source": {"source_id": SOURCE["source_id"], "video_sha256": SOURCE["video_sha256"], "audio_sha256": None}}], "samples": []})
        roles = {1: "loyal", 2: "loyal", 3: "oberon", 4: "percival", 5: "loyal", 6: "merlin", 7: "loyal", 8: "morgana", 9: "mordred", 10: "assassin"}
        if roles_variant:
            roles[1], roles[7] = roles[7], roles[1]
            roles[3], roles[9] = roles[9], roles[3]
        side = {"loyal": "good", "percival": "good", "merlin": "good"}
        roster = {"schema": "vbench.private_roster/2", "game_id": SOURCE["game_id"], "player_count": 10,
                  "composition": RULES["role_composition"],
                  "seats": [{"seat": s, "role": r, "side": side.get(r, "evil"), "verification": "verified",
                             "sources": [{"kind": "roster_crop"}], "consistency": {"checked_times": [1.0], "agree": True}} for s, r in roles.items()],
                  "end_of_video_reveal": {"available": False, "note": "t"}, "notes": []}
        write_json(annotation_paths(SOURCE["source_id"]).root / "private" / "roster_v2.json", roster)
    return build_agent_pairs(cfg, SOURCE, "accepted")
