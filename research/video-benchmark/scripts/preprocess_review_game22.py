"""Build the user's game-22 review revision from the frozen preprocess-v1."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

from preprocess_yuanzhuo22 import digest, read, record_errors, write_json

BVID = "BV1SEs56XE3r"
VERSION = "preprocess-v2-review"
RELEASE = "yuanzhuo-game22-preprocess-v2-review"
ALIASES = [
    {"alias": "马老师", "seat": 8, "required_public_text": ["8号马老师"],
     "evidence": "game22-v1/public/crops/subtitle/e52f37ba4af44034.png; 275.0833–276.9833 s; visually checked"},
    {"alias": "Jerry", "seat": 3, "required_public_text": ["3号Jerry"],
     "evidence": "game22-v1/public/crops/subtitle/54fcbd89492b1a90.png; 412.6167–414.2167 s; visually checked"},
    {"alias": "老马", "seat": 8, "required_public_text": ["8号马老师", "给老马 给马老师开一车"],
     "evidence": "public speech explicitly restates 给老马 as 给马老师 in the same sentence"},
]


def clean_review_speech(text, public_context, bvid=BVID):
    value, changes = text, []

    def apply(rule, after, **metadata):
        nonlocal value
        if value != after:
            changes.append({"rule": rule, "before": value, "after": after, **metadata})
            value = after

    # A nickname is only resolved inside its game, and only if this particular
    # input already contains the public mapping evidence. No later cutoff helps.
    if bvid == BVID:
        for entry in ALIASES:
            if not all(e in public_context for e in entry["required_public_text"]):
                continue
            name, seat = entry["alias"], entry["seat"]
            nickname = re.escape(name)
            if name.isascii():
                nickname = rf"(?<![A-Za-z]){nickname}(?![A-Za-z])"
            # Match apposition as one unit: 8号马老师 becomes 8号, not 8号8号.
            pattern = rf"(?:(?<![0-9]){seat}\s*号\s*{nickname}|{nickname}\s*{seat}\s*号|{nickname})"
            apply("nickname_to_seat", re.sub(pattern, f"{seat}号", value), **entry)
    before_fillers = value
    apply("remove_rhetorical_filler", re.sub(r"(^|[\s，。！？；：,.!?;:])(?:那)?我说啥呢(?=[\s，。！？；：,.!?;:]|$)", r"\1", value))
    # Preserve reported behavior (e.g. 8号笑了) and lexical words such as 哈哈镜.
    apply("remove_laughter_token", re.sub(r"(?<![\u4e00-\u9fffA-Za-z])哈{2,}(?![哈镜])", "", value))
    apply("normalize_spacing", re.sub(r"[ \t]+", " ", value).strip())
    # Keep the turn and speaker even when its whole verbal content was filler.
    if not value.strip(" ，。！？；：,.!?;:"):
        apply("empty_turn_marker", "[口头填充内容已删]")
    assert re.sub(r"\D", "", before_fillers) == re.sub(r"\D", "", value)
    for term in ("不", "没", "未", "无", "别", "可能", "也许", "应该", "一定", "梅林", "派西", "莫甘", "莫德", "奥伯", "刺客", "忠臣"):
        assert before_fillers.count(term) == value.count(term), (term, text, value)
    return value, changes


def main():
    releases = Path(__file__).resolve().parents[2] / "data/video-benchmark/releases"
    parent = releases / "yuanzhuo22-preprocess-v1"
    dest = releases / RELEASE
    stage = dest.with_name(dest.name + ".staging")
    if dest.exists() or stage.exists():
        raise RuntimeError("Refusing to overwrite an existing review revision")
    manifest = read(parent / "manifest.json")
    pairs = [p for p in manifest["pairs"] if p["bvid"] == BVID]
    frozen = {str(p): digest(p.read_bytes()) for folder in (parent, releases / "yuanzhuo22-v1") for p in folder.rglob("*") if p.is_file()}
    stage.mkdir(parents=True)
    output, full_edits = [], []
    for pair in pairs:
        before = (parent / pair["input_path"]).read_text(encoding="utf8")
        assert digest(before.encode()) == pair["input_sha256"]
        doc = read(parent / pair["blocks_path"])
        revised = copy.deepcopy(doc)
        replacements, edits = [], []
        for block in revised["blocks"]:
            for index, speech in enumerate(block["speech"]):
                raw = speech["text"]
                cleaned, steps = clean_review_speech(raw, before)
                speech["text"] = cleaned
                who = f"{speech['seat']}号" if speech["seat"] is not None else "说话人未知"
                replacements.append((f"{who}：{raw}", f"{who}：{cleaned}"))
                if steps:
                    edits.append({"block_id": block["block_id"], "paragraph": index + 1, "seat": speech["seat"], "before": raw, "after": cleaned, "steps": steps})
        for old, new in zip(doc["blocks"], revised["blocks"]):
            assert {k: v for k, v in old.items() if k != "speech"} == {k: v for k, v in new.items() if k != "speech"}
            assert [s["seat"] for s in old["speech"]] == [s["seat"] for s in new["speech"]]
        lines, at = before.splitlines(keepends=True), 0
        for old, new in replacements:
            while at < len(lines) and lines[at].rstrip("\r\n") != old:
                at += 1
            assert at < len(lines), old
            lines[at] = new + ("\n" if lines[at].endswith("\n") else "")
            at += 1
        after = "".join(lines)
        new_pair = copy.deepcopy(pair)
        sid = pair["sample_id"] + "-review2"
        new_pair.update(sample_id=sid, parent_sample_id=pair["sample_id"], parent_input_sha256=pair["input_sha256"], input_sha256=digest(after.encode()), preprocessing_version=VERSION)
        new_pair["size"].update(characters=len(after), utf8_bytes=len(after.encode()))
        input_path = stage / pair["input_path"]
        input_path.parent.mkdir(parents=True, exist_ok=True)
        input_path.write_bytes(after.encode())
        # Bind labels only after all transformations of public text are done.
        label = read(parent / pair["label_path"])
        old_label = copy.deepcopy(label)
        label.update(sample_id=sid, input_sha256=new_pair["input_sha256"])
        assert {k: v for k, v in label.items() if k not in ("sample_id", "input_sha256")} == {k: v for k, v in old_label.items() if k not in ("sample_id", "input_sha256")}
        assert not record_errors(label), record_errors(label)
        assert not record_errors(revised), record_errors(revised)
        write_json(stage / pair["blocks_path"], revised)
        write_json(stage / pair["label_path"], label)
        new_pair["label_sha256"] = digest((stage / pair["label_path"]).read_bytes())
        write_json(stage / pair["audit_path"], {"schema": "vbench.preprocessing_audit/1", "version": VERSION, "sample_id": sid,
                   "parent_sample_id": pair["sample_id"], "parent_audit_path": str(parent / pair["audit_path"]),
                   "parent_input_sha256": pair["input_sha256"], "input_sha256": new_pair["input_sha256"], "edits": edits})
        instruction = stage / pair["instruction_path"]
        instruction.write_text((parent / pair["instruction_path"]).read_text(encoding="utf8") + "\n本样本进一步采用 preprocess-v2-review：已核实的名字替换为座位号，清理‘我说啥呢’及直接笑声文字，保留玩家对别人行为的描述。\n", encoding="utf8")
        output.append(new_pair)
        if pair["kind"] == "full":
            full_edits = edits
    for path, sha in frozen.items():
        assert digest(Path(path).read_bytes()) == sha
    write_json(stage / "manifest.json", {**manifest, "release_id": RELEASE, "parent_release": str(parent), "games": [g for g in manifest["games"] if g["bvid"] == BVID], "pairs": output})
    write_json(stage / "aliases.json", {"bvid": BVID, "scope": "this game only; each input must contain the public evidence", "aliases": ALIASES})
    write_json(stage / "full_text_changes.json", full_edits)
    full = next(p for p in output if p["kind"] == "full")
    quality = {"games": 1, "pairs": len(output), "scope": "用户正在人工审核的 game22；其他21局尚未应用此次规则", "parent_files_unchanged": len(frozen),
               "labels_and_public_actions_unchanged": True, "full_characters": full["size"]["characters"], "changed_full_paragraphs": len(full_edits),
               "alias_operations_full": sum(s["rule"] == "nickname_to_seat" for e in full_edits for s in e["steps"]),
               "laughter_paragraphs_full": sum(any(s["rule"] == "remove_laughter_token" for s in e["steps"]) for e in full_edits)}
    write_json(stage / "quality.json", quality)
    (stage / "README.md").write_text("# game22 · preprocess-v2-review\n\n这是用户正在人工审核的 BV1SEs56XE3r 修订版，仅含这一局的全文及4个阶段快照。其他21局暂未应用本次规则，原文和 preprocess-v1 均保持不变。\n\n名字按本局公开证据归一：马老师、老马→8号；Jerry→3号。每份快照只使用自身已包含的对应证据，不能跨局套用号码或借用后续发言。马老师和 Jerry 已对照公开字幕截图核实；老马由同句的‘给老马 给马老师开一车’确定。\n\n删除独立口头短语‘（那）我说啥呢’和直接笑声‘哈哈哈’；保留‘8号笑了’之类的行为描述、身份判断、否定、改口和情绪表态。本轮未删除‘无所谓’或‘没意思’，也未把‘反正把把忠臣’改写为事实身份。原句‘这边我也不带我’与视频字幕一致，因此未猜测改写。\n\n模型只读取 inputs/ 中的正文和指令。答案在 evaluator/，仅用于评分。全文修改记录为 full_text_changes.json；每份样本的 audit.json 可回溯到上一版。清洗删掉了部分语用信息，不声称无损，也不是摘要版。\n", encoding="utf8")
    write_json(stage / "sha256.json", {p.relative_to(stage).as_posix(): digest(p.read_bytes()) for p in stage.rglob("*") if p.is_file()})
    stage.rename(dest)
    print(json.dumps(quality, ensure_ascii=False, indent=2))
    print(dest / full["input_path"])


if __name__ == "__main__":
    main()
