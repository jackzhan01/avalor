"""Build yuanzhuo22-preprocess-v2 from v1: standard boards only, one fixed role order, no nicknames.

Why v2 exists: v1 printed the board ("身份构成", the instruction's role list, manifest
games[].roles) in an order inherited from the private roster. The manifest order equals first
appearance over seats in string order "1,10,2,...,9", which let a rule with no access to the
dialogue name Merlin in 22/22 games; 5 input headers also varied per deal, and 9 inputs had no
composition line at all.

v2 changes exactly these things and records every text edit in a new audit layer:
  0. drops the 2 games on the show's variant board (执剑人/破壁人), whose abilities nothing documents;
  1. every input.zh.txt carries one composition line, rendered from ROLE_ORDER;
  2. every instruction.zh.txt lists the allowed roles in ROLE_ORDER;
  3. manifest games[].roles is re-keyed in ROLE_ORDER;
  4. names, nicknames and personal forms of address inside speech lines are replaced by the
     seat they refer to (or 某位玩家 when the transcript does not say), from a private map;
  5. local absolute paths are removed from manifest and statistics.
Objective events, cutoffs and labels' seat roles are unchanged. The builder reads labels only to
cross-check counts (a permutation-invariant check) and to rebind label files to new hashes.
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
# Private: it lists the very names being removed, so it lives beside the ignored data.
ANONYMIZATION = RELEASES / "anonymization-v2.json"

# Good roles first, then evil; a property of the rules, never of a deal.
ROLE_ORDER = ["merlin", "percival", "loyal", "mordred", "morgana", "assassin", "oberon"]
ZH = {"merlin": "梅林", "percival": "派西维尔", "loyal": "忠臣", "mordred": "莫德雷德", "morgana": "莫甘娜",
      "assassin": "刺客", "oberon": "奥伯伦"}
COMPOSITION = re.compile(r"^身份构成：.*$", re.M)
ALLOWED = re.compile(r"(取值只能是：)([^。\n]+)(。)")
SPEECH = re.compile(r"^((?:10|[1-9])号|说话人未知)：(.*)$")
VERSION = "preprocess-v2"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path):
    return json.loads(path.read_text(encoding="utf8"))


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def standard(roles: dict) -> bool:
    return set(roles) <= set(ROLE_ORDER)


def canonical(roles: dict) -> dict:
    assert standard(roles), roles
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


def replacement(rule: dict) -> str:
    return rule.get("replace") or (f"{rule['seat']}号" if rule.get("seat") else "某位玩家")


def anonymize(text: str, rules: list) -> tuple[str, list]:
    """Replace each rule's literal `find` inside speech lines only; headers and events stay as they are.

    A rule naming a seat also collapses "8号马老师", "8号的马老师", "马老师（8号）" and "Jerry3号" to the
    bare seat, so it is not doubled. Longer strings go first, so "马老师" is handled before "老马".
    Single-character nicknames are never rules on their own; their rules quote the whole phrase.
    """
    rules = sorted(rules, key=lambda r: -len(r["find"]))
    assert all(len(r["find"]) > 1 for r in rules), "quote the phrase around a one-character nickname"
    counts = Counter()
    lines = []
    for line in text.split("\n"):
        m = SPEECH.match(line)
        if m:
            body = m[2]
            for i, rule in enumerate(rules):
                find, seat = rule["find"], rule.get("seat")
                if seat and not rule.get("replace"):
                    for joined in (f"{seat}号的{find}", f"{seat}号{find}", f"{find}（{seat}号）", f"{find}({seat}号)",
                                   f"{find}{seat}号"):
                        counts[i] += body.count(joined)
                        body = body.replace(joined, f"{seat}号")
                counts[i] += body.count(find)
                body = body.replace(find, replacement(rule))
            line = f"{m[1]}：{body}"
        lines.append(line)
    edits = [{"rule": "anonymize", "find": rules[i]["find"], "replace": replacement(rules[i]), "count": n}
             for i, n in sorted(counts.items()) if n]
    return "\n".join(lines), edits


def load_anonymization() -> dict | None:
    return read(ANONYMIZATION)["games"] if ANONYMIZATION.exists() else None


def build():
    for rel, digest in read(V1 / "sha256.json").items():
        assert sha((V1 / rel).read_bytes()) == digest, rel
    names = load_anonymization()
    assert names is not None, f"missing private map {ANONYMIZATION}"
    if V2.exists():
        shutil.rmtree(V2)
    V2.mkdir(parents=True)
    manifest = read(V1 / "manifest.json")
    excluded = [g["bvid"] for g in manifest["games"] if not standard(g["roles"])]
    assert len(excluded) == 2, excluded
    out = copy.deepcopy(manifest)
    out.update(release_id="yuanzhuo22-preprocess-v2", parent_release="yuanzhuo22-preprocess-v1", role_order=ROLE_ORDER,
               excluded_games={"bvids": excluded, "reason": "variant board with 执剑人/破壁人; abilities undocumented"},
               v2_changes=["drop variant-board games", "composition line in every input, in role_order",
                           "instruction role list in role_order", "manifest games[].roles keyed in role_order",
                           "names and nicknames in speech replaced by seat numbers", "local absolute paths removed"])
    out["games"] = [g for g in out["games"] if g["bvid"] not in excluded]
    out["pairs"] = [p for p in out["pairs"] if p["bvid"] not in excluded]
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
        text, board_edit = fix_input(old.decode("utf8"), game["roles"])
        text, name_edits = anonymize(text, names.get(pair["bvid"], []))
        new = text.encode("utf8")
        (V2 / pair["input_path"]).parent.mkdir(parents=True, exist_ok=True)
        (V2 / pair["input_path"]).write_bytes(new)
        sample_id = pair["sample_id"] + "-v2"
        audit_path = pair["audit_path"].replace("audit.json", "audit.v2.json")
        write_json(V2 / audit_path, {"schema": "vbench.preprocess_audit/1", "version": VERSION,
                                     "parent_sample_id": pair["sample_id"], "sample_id": sample_id,
                                     "parent_input_sha256": pair["input_sha256"], "input_sha256": sha(new),
                                     "parent_release": "yuanzhuo22-preprocess-v1",
                                     "parent_audit_path": pair["audit_path"], "edits": [board_edit] + name_edits})
        label.update(input_sha256=sha(new), sample_id=sample_id)
        write_json(V2 / pair["label_path"], label)
        if (V1 / pair["blocks_path"]).exists():
            shutil.copy2(V1 / pair["blocks_path"], V2 / pair["blocks_path"])  # evaluator-side, private
        instructions[pair["instruction_path"]] = game["roles"]
        pair.update(parent_sample_id=pair["sample_id"], sample_id=sample_id, parent_input_sha256=pair["input_sha256"],
                    input_sha256=sha(new), label_sha256=sha((V2 / pair["label_path"]).read_bytes()),
                    audit_path=audit_path, preprocessing_version=VERSION)
    for rel, roles in instructions.items():
        text = (V1 / rel).read_text(encoding="utf8")
        (V2 / rel).write_text(fix_instruction(text, roles), encoding="utf8")
    stats = read(V1 / "statistics.json")
    stats["games"] = [g for g in stats["games"] if g["bvid"] not in excluded]
    for g in stats["games"]:
        g.pop("full_input_original", None)
        g["full_input_preprocess"] = f"inputs/{g['bvid']}/full/input.zh.txt"
    stats["summary_scope"] = "summary was computed by preprocess-v1 over 22 games, before v2 dropped 2"
    write_json(V2 / "statistics.json", stats)
    write_json(V2 / "manifest.json", out)
    (V2 / "README.md").write_text(README, encoding="utf8")
    write_json(V2 / "sha256.json", {p.relative_to(V2).as_posix(): sha(p.read_bytes())
                                    for p in sorted(V2.rglob("*")) if p.is_file() and p.name != "sha256.json"})
    verify()


ABSOLUTE = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/](?!/)|/Users/|/home/|file://")  # not https://


def verify():
    """Acceptance checks; also run by tests/test_yuanzhuo22_v2.py."""
    manifest = read(V2 / "manifest.json")
    for rel, digest in read(V2 / "sha256.json").items():
        assert sha((V2 / rel).read_bytes()) == digest, rel
    # v1 and the name map are private; where they are absent, check v2 on its own.
    with_v1 = (V1 / "manifest.json").exists()
    names = load_anonymization()
    for rel in ("manifest.json", "statistics.json"):
        assert not ABSOLUTE.search((V2 / rel).read_text(encoding="utf8")), rel
    games = {g["bvid"]: g for g in manifest["games"]}
    for g in manifest["games"]:
        assert list(g["roles"]) == [r for r in ROLE_ORDER if r in g["roles"]], g["bvid"]
    for pair in manifest["pairs"]:
        roles = games[pair["bvid"]]["roles"]
        new = (V2 / pair["input_path"]).read_text(encoding="utf8")
        assert COMPOSITION.findall(new) == [composition_line(roles)], pair["sample_id"]
        label = read(V2 / pair["label_path"])
        assert label["input_sha256"] == pair["input_sha256"] == sha(new.encode("utf8"))
        assert Counter(s["role"] for s in label["seats"].values()) == Counter(roles)
        if names is not None:
            for rule in names.get(pair["bvid"], []):
                assert rule["find"] not in new, (pair["sample_id"], "name left in text")
        if with_v1 and names is not None:
            old = (V1 / pair["input_path"]).read_text(encoding="utf8")
            expected = anonymize(fix_input(old, roles)[0], names.get(pair["bvid"], []))[0]
            assert new == expected, "only the composition line and listed names may change"
            assert label["seats"] == read(V1 / pair["label_path"])["seats"]
        instruction = (V2 / pair["instruction_path"]).read_text(encoding="utf8")
        assert ALLOWED.search(instruction)[2] == "、".join(ZH[r] for r in roles)
    assert len(games) == 20 and len(manifest["pairs"]) == 102
    boards = Counter(composition_line(g["roles"]) for g in manifest["games"])
    return {"games": len(games), "pairs": len(manifest["pairs"]), "distinct_composition_lines": len(boards),
            "compared_with_v1": with_v1 and names is not None, "names_checked": names is not None}


README = """# 圆桌谜局 preprocess-v2

上一版：../yuanzhuo22-preprocess-v1。**v1 有已验证的标签泄漏，新实验一律用 v2。**

## v1 的问题

身份列表的顺序继承自私有底牌文件，随局变化：

- `manifest.json` 的 `games[].roles` 按座位字符串顺序 `1,10,2,…,9` 记录各身份第一次出现的顺序。用它拼板子说明时，只看名单和派西的两个候选座位，就能在 22/22 局认出梅林。
- 5 局 `input.zh.txt` 的「身份构成」行顺序逐局不同，其中 `BV1pYtc6mEcd` 恰好等于 1→10 号座位的首次出现顺序。
- 9 局 `input.zh.txt` 没有「身份构成」行，模型从输入本身无法得知板子。

## v2 改了什么

1. 去掉 2 局含执剑人、破壁人的节目变体板（`BV1AApJ6pEY4`、`BV1hAJX6SEVp`），这两个身份的能力没有任何记录。剩 20 局、102 份输入，全部是常规十人板。
2. 每份 `input.zh.txt` 都有且仅有一行「身份构成」，顺序固定为先好人后坏人：`梅林、派西维尔、忠臣、莫德雷德、莫甘娜、刺客、奥伯伦`。没有这一行的，插在「规则：」行之后。
3. `instruction.zh.txt` 的「取值只能是」列表和 `manifest.json` 的 `games[].roles` 用同一顺序。
4. 发言中的人名、外号和称呼换成所指的座位号（如「8号」）；转写本身判断不出是谁的，换成「某位玩家」。替换表含原名，单独私存，不随发布包分发。
5. `manifest.json` 与 `statistics.json` 去掉本机绝对路径。

客观行动、截止点与每个座位的真实身份不变。每处文本修改记录在 `evaluator/**/audit.v2.json`。样本 ID 加后缀 `-v2`，`label.json` 的 `input_sha256` 和 `sample_id` 同步更新。

## 验收

`python research/video-benchmark/scripts/release_yuanzhuo22_v2.py --verify` 检查：所有身份列表都等于固定顺序；替换表中的名字不再出现；有 v1 和替换表时，v2 正文必须恰好等于「v1 + 身份构成行 + 名字替换」；标签绑定新哈希且座位身份与 v1 相同；清单和统计里没有绝对路径；`sha256.json` 全部匹配。

`evaluator/` 下的 v1 审计链（`audit.json`）和 `blocks.json` 含清洗前原文，只供内部追溯，不公开发布。
"""


if __name__ == "__main__":
    import argparse
    cli = argparse.ArgumentParser()
    cli.add_argument("--verify", action="store_true", help="only re-check an existing v2")
    args = cli.parse_args()
    if not args.verify:
        build()
    print(json.dumps(verify(), ensure_ascii=False))
