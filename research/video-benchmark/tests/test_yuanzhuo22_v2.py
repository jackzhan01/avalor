"""v2: standard boards only, role lists in one rules-fixed order, nicknames replaced by seats."""
import importlib.util
import re
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("release_v2", Path(__file__).parents[1] / "scripts/release_yuanzhuo22_v2.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NL = "\n"


def test_composition_line_ignores_dict_order():
    # Same board, keys inserted in two deal-dependent orders -> identical text.
    a = {"loyal": 4, "assassin": 1, "oberon": 1, "percival": 1, "merlin": 1, "morgana": 1, "mordred": 1}
    b = dict(reversed(list(a.items())))
    assert module.composition_line(a) == module.composition_line(b)
    assert module.composition_line(a) == "身份构成：梅林 1、派西维尔 1、忠臣 4、莫德雷德 1、莫甘娜 1、刺客 1、奥伯伦 1。"


def test_missing_composition_line_is_added_after_rules():
    text = NL.join(["# 阿瓦隆对局记录", "", "规则：10 人局。", "座位：1 号到 10 号。", "", "第1轮任务 · 第1次组队", ""])
    fixed, edit = module.fix_input(text, {"merlin": 1, "percival": 1, "loyal": 4, "morgana": 1, "mordred": 1,
                                          "assassin": 1, "oberon": 1})
    assert edit["rule"] == "add_composition_line"
    assert fixed.splitlines()[3].startswith("身份构成：梅林 1")
    assert module.strip_composition(fixed) == text


def test_leaky_order_is_replaced_and_body_untouched():
    text = NL.join(["规则：x", "身份构成：忠臣 4、刺客 1、梅林 1、派西维尔 1、莫甘娜 1、莫德雷德 1、奥伯伦 1。", "1号：我是派", ""])
    roles = {"loyal": 4, "assassin": 1, "merlin": 1, "percival": 1, "morgana": 1, "mordred": 1, "oberon": 1}
    fixed, edit = module.fix_input(text, roles)
    assert edit["rule"] == "canonical_composition_line"
    assert re.search(r"^身份构成：梅林 1、派西维尔 1、忠臣 4、莫德雷德 1", fixed, re.M)
    assert fixed.endswith("1号：我是派" + NL)


def test_instruction_role_list_is_canonical():
    text = "- 取值只能是：刺客、忠臣、梅林、奥伯伦、莫甘娜、派西维尔、莫德雷德。" + NL
    roles = {"assassin": 1, "loyal": 4, "merlin": 1, "oberon": 1, "morgana": 1, "percival": 1, "mordred": 1}
    assert module.fix_instruction(text, roles) == "- 取值只能是：梅林、派西维尔、忠臣、莫德雷德、莫甘娜、刺客、奥伯伦。" + NL


def test_variant_board_is_not_standard():
    assert not module.standard({"merlin": 1, "swordholder": 1, "wallbreaker": 1})
    with pytest.raises(AssertionError):
        module.canonical({"merlin": 1, "swordholder": 1})


def test_nickname_becomes_seat_without_doubling():
    rules = [{"find": "马老师", "seat": "8"}, {"find": "Jerry", "seat": "3"}, {"find": "赵律师"}]
    text = NL.join(["规则：马老师 不在发言里，不改",
                    "1号：8号马老师发言还可以 你像8号的马老师说",
                    "2号：马老师（8号）跳派 Jerry3号 和 3号Jerry 都是好人",
                    "3号：赵律师你是好人吗"])
    out, edits = module.anonymize(text, rules)
    assert out.splitlines() == ["规则：马老师 不在发言里，不改", "1号：8号发言还可以 你像8号说",
                                "2号：8号跳派 3号 和 3号 都是好人", "3号：某位玩家你是好人吗"]
    assert {e["find"]: e["count"] for e in edits} == {"马老师": 3, "Jerry": 2, "赵律师": 1}


def test_one_character_nickname_needs_its_phrase():
    with pytest.raises(AssertionError):
        module.anonymize("1号：牛你好", [{"find": "牛", "seat": "7"}])
    out, _ = module.anonymize("1号：牛你不会又是摸莫甘娜了 牛逼",
                              [{"find": "牛你不会", "seat": "7", "replace": "7号你不会"}])
    assert out == "1号：7号你不会又是摸莫甘娜了 牛逼"


@pytest.mark.skipif(not (module.V2 / "manifest.json").exists(), reason="release data is local-only (research/data is ignored)")
def test_built_release_passes_acceptance():
    summary = module.verify()
    assert {k: summary[k] for k in ("games", "pairs", "distinct_composition_lines")} == \
        {"games": 20, "pairs": 102, "distinct_composition_lines": 1}
