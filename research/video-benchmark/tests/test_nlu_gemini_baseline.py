"""Protect public/private separation, event order, and role-inference scoring."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from nlu_gemini_baseline import payload, public_text, parse_prediction, score_prediction, run
import nlu_gemini_baseline as baseline


def message(player, text, mid="same"):
    return {"player": player, "msg": text, "mid": mid, "quest": 1, "turn": 1}


def test_duplicate_mids_preserve_all_distinct_public_events():
    ms = {"1": message("system", "party vote outcome"), "2": message("system", "vote succeeded!")}
    text, ids = public_text(ms)
    assert ids == ["1", "2"] and "party vote outcome" in text and "vote succeeded!" in text


def test_cut_before_terminal_and_postgame_messages():
    ms = {"1": message("player-1", "I am Merlin"), "2": message("system", "good won for now, but the assassin..."), "3": message("player-2", "revealed role")}
    text, ids = public_text(ms)
    assert ids == ["1"] and "I am Merlin" in text and "revealed" not in text


def test_numeric_record_order_not_lexical_order():
    ms = {str(i): message("player-1", str(i)) for i in (10, 2, 1)}
    assert public_text(ms)[1] == ["1", "2", "10"]


def test_payload_only_contains_supplied_public_text():
    result = payload("public sentinel", "instruction sentinel")
    assert result["contents"][0]["parts"][0]["text"] == "public sentinel"
    assert "tools" not in result
    assert "labels" not in str(result) and "beliefs" not in str(result)


def response(text, finish="STOP"):
    return {"candidates": [{"finishReason": finish, "content": {"parts": [{"text": text}]}}]}


def test_truncated_json_is_not_accepted_as_success():
    assert parse_prediction(response('{}', "MAX_TOKENS"))[0] is None
    assert parse_prediction(response('{}'))[0] is None


def test_role_and_side_metrics_are_distinct():
    actual = {"1": "merlin", "2": "percival", "3": "morgana", "4": "assassin", "5": "servant", "6": "servant"}
    pred = {**actual, "3": "assassin", "4": "morgana"}
    score = score_prediction(pred, actual)
    assert score["role_correct"] == 4 and score["side_correct"] == 6
    assert not score["all_roles_correct"] and score["composition_valid"]


def test_wrong_composition_is_flagged_without_repairing_answer():
    actual = {"1": "merlin", "2": "percival", "3": "morgana", "4": "assassin", "5": "servant", "6": "servant"}
    pred = {str(i): "servant" for i in range(1, 7)}
    saved = copy.deepcopy(pred)
    result = score_prediction(pred, actual)
    assert not result["composition_valid"] and result["role_correct"] == 2 and pred == saved


def test_no_network_without_confirmed_free_project():
    with pytest.raises(RuntimeError, match="Free tier"):
        run({}, 20, False)


def test_recovery_cannot_resample_valid_answers(tmp_path, monkeypatch):
    monkeypatch.setattr(baseline, "RUN", tmp_path)
    monkeypatch.setattr(baseline, "api_key", lambda _: "test-placeholder")
    actual = {"1": "merlin", "2": "percival", "3": "morgana", "4": "assassin", "5": "servant", "6": "servant"}
    (tmp_path / "game").mkdir()
    (tmp_path / "game/result.json").write_text(json.dumps({"status": "ok", "response": response(json.dumps(actual))}), encoding="utf8")
    with pytest.raises(RuntimeError, match="already valid"):
        run({"pairs": [{"game_id": "game"}]}, 1, True, retry_game="game")
