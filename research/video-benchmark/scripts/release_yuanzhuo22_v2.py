"""Build yuanzhuo22-preprocess-v2: v1 with every role list printed in one fixed, label-free order.

Why v2 exists: v1 printed the board ("身份构成", the instruction's role list, manifest
games[].roles) in an order inherited from the private roster. In 5 games the input header
order varies per game (one equals first appearance over seats 1..10), and the manifest order
equals first appearance over seats in string order "1,10,2,...,9", which let a rule with no
access to the dialogue name Merlin in 22/22 games. 9 games had no composition line at all.

v2 changes exactly three things and records each edit in a new audit layer:
  1. every input.zh.txt carries one composition line, rendered from ROLE_ORDER;
  2. every instruction.zh.txt lists the allowed roles in ROLE_ORDER;
  3. manifest games[].roles is re-keyed in ROLE_ORDER.
Dialogue, objective events, cutoffs and labels' seat roles are byte-for-byte unchanged.
The builder reads labels only to cross-check counts (a permutation-invariant check) and to
rebind label files to the new input hashes.
"""
import copy
import hashlib
import json
import re
import shutil
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RELEASES = REPO / "research/data/video-benchmark/releases"
V1 = RELEASES / "yuanzhuo22-preprocess-v1"
V2 = RELEASES / "yuanzhuo22-preprocess-v2"

# Good roles first, then evil; a property of the rules, never of a deal.
ROLE_ORDER = ["merlin", "percival", "loyal", "swordholder", "morgana", "mordred", "assassin", "oberon",
              "wallbreaker"]
ZH = {"merlin": "梅林", "percival": "派西维尔", "loyal": "忠臣", "swordholder": "执剑人", "morgana": "莫甘娜",
      "mordred": "莫德雷德", "assassin": "刺客", "oberon": "奥伯伦", "wallbreaker": "破壁人"}
COMPOSITION = re.compile(r"^身份构成：.*$", re.M)
ALLOWED = re.compile(r"(取值只能是：)([^。\n]+)(。)")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path):
    return json.loads(path.read_text(encoding="utf8"))


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def canonical(roles: dict) -> dict:
    assert set(roles) <= set(ROLE_ORDER), roles
    return {r: roles[r] for r in ROLE_ORDER if r in roles}


def composition_line(roles: dict) -> str:
    return "身份构成：" + "、".join(f"{ZH[r]} {n}" for r, n in canonical(roles).items()) + "。"


def fix_input(text: str, roles: dict) -> tuple[str, dict]:
    line = composition_line(roles)
    found = COMPOSITION.findall(text)
    assert len(found) <= 1
    if found:
        return COMPOSITION.sub(line, text), {"rule": "canonical_composition_line", "before": found[0], "after": line}
    rules = [m for m in re.finditer(r"^规则：.*$", text, re.M)]
    assert len(rules) == 1, "expected exactly one rules line"
    at = rules[0].end()
    return text[:at] + "\n" + line + text[at:], {"rule": "add_composition_line", "before": None, "after": line}


def fix_instruction(text: str, roles: dict) -> str:
    assert len(ALLOWED.findall(text)) == 1
    names = "、".join(ZH[r] for r in canonical(roles))
    return ALLOWED.sub(lambda m: m[1] + names + m[3], text)


def strip_composition(text: str) -> str:
    return re.sub(r"^身份构成：.*\n", "", text, flags=re.M)


def build():
    for rel, digest in read(V1 / "sha256.json").items():
        assert sha((V1 / rel).read_bytes()) == digest, rel
    if V2.exists():
        shutil.rmtree(V2)
    shutil.copytree(V1, V2)
    manifest = read(V1 / "manifest.json")
    out = copy.deepcopy(manifest)
    out["release_id"] = "yuanzhuo22-preprocess-v2"
    out["parent_release"] = "yuanzhuo22-preprocess-v1"
    out["v2_changes"] = ["composition line in every input, in role_order", "instruction role list in role_order",
                         "manifest games[].roles keyed in role_order"]
    out["role_order"] = ROLE_ORDER
    games = {g["bvid"]: g for g in out["games"]}
    for g in out["games"]:
        g["roles"] = canonical(g["roles"])
    instructions = {}
    for pair in out["pairs"]:
        game = games[pair["bvid"]]
        label = read(V1 / pair["label_path"])
        assert Counter(s["role"] for s in label["seats"].values()) == Counter(game["roles"]), pair["sample_id"]
        old = (V1 / pair["input_path"]).read_bytes()
        assert sha(old) == pair["input_sha256"]
        text, edit = fix_input(old.decode("utf8"), game["roles"])
        new = text.encode("utf8")
        (V2 / pair["input_path"]).write_bytes(new)
        sample_id = pair["sample_id"] + "-cb"
        audit_path = pair["audit_path"].replace("audit.json", "audit.v2.json")
        write_json(V2 / audit_path, {"schema": "vbench.preprocess_audit/1", "version": "preprocess-v2-canonical-board",
                                     "parent_sample_id": pair["sample_id"], "sample_id": sample_id,
                                     "parent_input_sha256": pair["input_sha256"], "input_sha256": sha(new),
                                     "parent_audit_path": pair["audit_path"], "edits": [edit]})
        label.update(input_sha256=sha(new), sample_id=sample_id)
        write_json(V2 / pair["label_path"], label)
        instructions[pair["instruction_path"]] = game["roles"]
        pair.update(parent_sample_id=pair["sample_id"], sample_id=sample_id, parent_input_sha256=pair["input_sha256"],
                    input_sha256=sha(new), label_sha256=sha((V2 / pair["label_path"]).read_bytes()),
                    audit_path=audit_path, preprocessing_version="preprocess-v2-canonical-board")
    for rel, roles in instructions.items():
        text = (V1 / rel).read_text(encoding="utf8")
        (V2 / rel).write_text(fix_instruction(text, roles), encoding="utf8")
    write_json(V2 / "manifest.json", out)
    (V2 / "README.md").write_text(README, encoding="utf8")
    (V2 / "sha256.json").unlink()
    write_json(V2 / "sha256.json", {p.relative_to(V2).as_posix(): sha(p.read_bytes())
                                    for p in sorted(V2.rglob("*")) if p.is_file()})
    verify()


def verify():
    """Acceptance checks; also run by tests/test_yuanzhuo22_v2.py."""
    manifest = read(V2 / "manifest.json")
    for rel, digest in read(V2 / "sha256.json").items():
        assert sha((V2 / rel).read_bytes()) == digest, rel
    games = {g["bvid"]: g for g in manifest["games"]}
    for g in manifest["games"]:
        assert list(g["roles"]) == [r for r in ROLE_ORDER if r in g["roles"]], g["bvid"]
    for pair in manifest["pairs"]:
        roles = games[pair["bvid"]]["roles"]
        new = (V2 / pair["input_path"]).read_text(encoding="utf8")
        old = (V1 / pair["input_path"]).read_text(encoding="utf8")
        assert COMPOSITION.findall(new) == [composition_line(roles)], pair["sample_id"]
        assert strip_composition(new) == strip_composition(old), "only the composition line may change"
        label = read(V2 / pair["label_path"])
        assert label["input_sha256"] == pair["input_sha256"] == sha(new.encode("utf8"))
        assert label["seats"] == read(V1 / pair["label_path"])["seats"]
        instruction = (V2 / pair["instruction_path"]).read_text(encoding="utf8")
        assert ALLOWED.search(instruction)[2] == "、".join(ZH[r] for r in roles)
    assert len(manifest["pairs"]) == 112
    boards = Counter(composition_line(g["roles"]) for g in manifest["games"])
    return {"games": len(games), "pairs": len(manifest["pairs"]), "distinct_composition_lines": len(boards)}


README = """# 圆桌谜局 preprocess-v2（固定身份顺序）

上一版：../yuanzhuo22-preprocess-v1。**v1 有已验证的标签泄漏，新实验一律用 v2。**

## v1 的问题

身份列表的顺序继承自私有底牌文件，随局变化：

- `manifest.json` 的 `games[].roles` 按座位字符串顺序 `1,10,2,…,9` 记录各身份第一次出现的顺序。用它拼板子说明时，只看名单和派西的两个候选座位，就能在 22/22 局认出梅林。
- 5 局 `input.zh.txt` 的「身份构成」行顺序逐局不同，其中 `BV1pYtc6mEcd` 恰好等于 1→10 号座位的首次出现顺序。
- 9 局 `input.zh.txt` 没有「身份构成」行，模型从输入本身无法得知板子。

## v2 只改了三处

1. 每份 `input.zh.txt` 都有且仅有一行「身份构成」，顺序固定为规则表 `梅林、派西维尔、忠臣、执剑人、莫甘娜、莫德雷德、刺客、奥伯伦、破壁人`（只列本局有的身份）。没有这一行的，插在「规则：」行之后。
2. 每份 `instruction.zh.txt` 的「取值只能是」列表用同一顺序。
3. `manifest.json` 的 `games[].roles` 按同一顺序重排键。

发言、客观行动、截止点与每个座位的真实身份逐字节不变。每次修改记录在 `evaluator/**/audit.v2.json`，`parent_audit_path` 指回 v1 审计链。样本 ID 加后缀 `-cb`，`label.json` 的 `input_sha256` 和 `sample_id` 同步更新。

## 验收

`python research/video-benchmark/scripts/release_yuanzhuo22_v2.py --verify` 检查：

- 所有身份列表都等于规则表顺序，与发牌无关；
- 去掉「身份构成」行后，v1 和 v2 的正文完全相同；
- 标签绑定新哈希，座位身份与 v1 相同；`sha256.json` 全部匹配。

注意：`statistics.json` 和 `dataset-overview.html` 原样复制，其中的绝对路径仍指向 v1，统计数字不受影响。
"""


if __name__ == "__main__":
    import argparse
    cli = argparse.ArgumentParser()
    cli.add_argument("--verify", action="store_true", help="only re-check an existing v2")
    args = cli.parse_args()
    if not args.verify:
        build()
    print(json.dumps(verify(), ensure_ascii=False))
