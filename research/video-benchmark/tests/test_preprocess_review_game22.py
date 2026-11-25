"""Regression checks for user-reviewed name normalization and filler removal."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from preprocess_review_game22 import clean_review_speech

EVIDENCE = "8号马老师 3号Jerry 给老马 给马老师开一车"


def test_names_are_resolved_without_duplicating_seat():
    result, _ = clean_review_speech("8号马老师说Jerry像好人 老马笑了 3号Jerry发言", EVIDENCE)
    assert result == "8号说3号像好人 8号笑了 3号发言"


def test_same_name_does_not_imply_same_seat_in_another_game():
    assert clean_review_speech("马老师像好人", EVIDENCE, "another-game")[0] == "马老师像好人"


def test_future_evidence_cannot_resolve_earlier_cutoff():
    assert clean_review_speech("马老师像好人", "马老师像好人")[0] == "马老师像好人"


def test_partial_english_name_does_not_match():
    assert clean_review_speech("Jerryson不像好人", EVIDENCE)[0] == "Jerryson不像好人"


def test_filler_deletion_preserves_emotion_identity_and_negation():
    text = "那我说啥呢 这边也不带 我说啥呢 哈哈哈过了呗 无所谓了 反正把把忠臣无所谓了 没意思"
    assert clean_review_speech(text, text)[0] == "这边也不带 过了呗 无所谓了 反正把把忠臣无所谓了 没意思"


def test_reported_laughter_and_lexical_words_are_kept():
    assert clean_review_speech("马老师笑了 我看的是哈哈镜", EVIDENCE)[0] == "8号笑了 我看的是哈哈镜"


def test_empty_turn_still_has_a_record():
    assert clean_review_speech("哈哈哈", "哈哈哈")[0] == "[口头填充内容已删]"


def test_audit_steps_chain_and_transform_is_idempotent():
    text = "那我说啥呢 马老师是好人 哈哈哈"
    result, steps = clean_review_speech(text, EVIDENCE)
    current = text
    for step in steps:
        assert current == step["before"]
        current = step["after"]
    assert current == result
    assert clean_review_speech(result, EVIDENCE)[0] == result
