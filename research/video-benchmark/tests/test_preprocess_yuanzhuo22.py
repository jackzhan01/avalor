"""Protect the evidence needed by role inference while cleaning public speech."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("preprocess", Path(__file__).parents[1] / "scripts/preprocess_yuanzhuo22.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
clean = module.clean_speech


def test_particle_removal_preserves_uncertainty_and_negation():
    result, changes = clean("呃 我觉得……3号可能不是坏人吧")
    assert result == "我觉得3号可能不是坏人"
    assert changes


def test_self_correction_and_repeated_claims_stay():
    original = "不是不是 我刚才说错了 我保3 我保3 现在我改踩3"
    assert clean(original)[0] == original


def test_confirmation_questions_and_lexical_words_stay():
    original = "是吧 对吧 我们在酒吧 他看贴吧"
    assert clean(original)[0] == original


def test_no_unsupported_seat_correction():
    original = "4-6-78号肯定不行"
    assert clean(original)[0] == original
    assert clean(original, "BV1SEs56XE3r")[0] == "4-6-7 8号肯定不行"


def test_no_invented_claim_for_vocalization_only():
    assert clean("嗯")[0] == "嗯"


def test_role_claims_and_numbers_stay():
    result, _ = clean("我不是梅林啊 我是忠臣吧 10号可能是刺客啊 3号也许是派西吧")
    assert result == "我不是梅林 我是忠臣 10号可能是刺客 3号也许是派西"


def test_change_log_reconstructs_transformation():
    original = "呃 我觉得我觉得……3号可能不是坏人吧   "
    result, changes = clean(original)
    current = original
    for step in changes:
        assert step["before"] == current
        current = step["after"]
    assert current == result


def test_context_free_transformation_is_repeatable():
    text = "呃 我觉得……3号可能不是坏人吧"
    first = clean(text)
    clean("我知道3号是莫甘娜")
    assert clean(text) == first
    assert clean(first[0])[0] == first[0]
