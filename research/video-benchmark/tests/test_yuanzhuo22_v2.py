"""The v2 release must print role lists in one rules-fixed order, never one inherited from a deal."""
import importlib.util
import re
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("release_v2", Path(__file__).parents[1] / "scripts/release_yuanzhuo22_v2.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_composition_line_ignores_dict_order():
    # Same board, keys inserted in two deal-dependent orders -> identical text.
    a = {"loyal": 4, "assassin": 1, "oberon": 1, "percival": 1, "merlin": 1, "morgana": 1, "mordred": 1}
    b = dict(reversed(list(a.items())))
    assert module.composition_line(a) == module.composition_line(b)
    assert module.composition_line(a) == "身份构成：梅林 1、派西维尔 1、忠臣 4、莫甘娜 1、莫德雷德 1、刺客 1、奥伯伦 1。"


def test_missing_composition_line_is_added_after_rules():
    text = "# 阿瓦隆对局记录\n\n规则：10 人局。\n座位：1 号到 10 号。\n\n第1轮任务 · 第1次组队\n"
    fixed, edit = module.fix_input(text, {"merlin": 1, "percival": 1, "loyal": 4, "morgana": 1, "mordred": 1,
                                          "assassin": 1, "oberon": 1})
    assert edit["rule"] == "add_composition_line"
    assert fixed.splitlines()[3].startswith("身份构成：梅林 1")
    assert module.strip_composition(fixed) == text


def test_leaky_order_is_replaced_and_body_untouched():
    text = "规则：x\n身份构成：忠臣 4、刺客 1、梅林 1、派西维尔 1、莫甘娜 1、莫德雷德 1、奥伯伦 1。\n1号：我是派\n"
    roles = {"loyal": 4, "assassin": 1, "merlin": 1, "percival": 1, "morgana": 1, "mordred": 1, "oberon": 1}
    fixed, edit = module.fix_input(text, roles)
    assert edit["rule"] == "canonical_composition_line"
    assert re.search(r"^身份构成：梅林 1、派西维尔 1、忠臣 4", fixed, re.M)
    assert fixed.endswith("1号：我是派\n")


def test_instruction_role_list_is_canonical():
    text = "- 取值只能是：刺客、忠臣、梅林、莫德雷德、莫甘娜、派西维尔、执剑人、破壁人。\n"
    roles = {"assassin": 1, "loyal": 3, "merlin": 1, "mordred": 1, "morgana": 1, "percival": 1, "swordholder": 1,
             "wallbreaker": 1}
    assert module.fix_instruction(text, roles) == "- 取值只能是：梅林、派西维尔、忠臣、执剑人、莫甘娜、莫德雷德、刺客、破壁人。\n"


@pytest.mark.skipif(not (module.V2 / "manifest.json").exists(), reason="release data is local-only (research/data is ignored)")
def test_built_release_passes_acceptance():
    summary = module.verify()
    assert {k: summary[k] for k in ("games", "pairs", "distinct_composition_lines")} == \
        {"games": 22, "pairs": 112, "distinct_composition_lines": 2}
