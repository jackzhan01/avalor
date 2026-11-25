"""Create an auditable speech-cleaning derivative without reading labels to clean text."""
from __future__ import annotations

import copy
import hashlib
import html
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from vbench.validate import record_errors  # noqa: E402

VERSION = "preprocess-v1"
KNOWN_FIXES = {
    "BV1SEs56XE3r": [("4-6-78号肯定不行", "4-6-7 8号肯定不行",
        "game22-v1/public/crops/subtitle/0115420a1a6b40cb.png; 265.75–267.65 s; source visibly separates 7 and 8")],
}


def read(p):
    return json.loads(p.read_text(encoding="utf8"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def clean_speech(text, bvid=""):
    changes = []
    value = text

    def apply(name, new):
        nonlocal value
        if new != value:
            changes.append({"rule": name, "before": value, "after": new})
            value = new

    for before, after, evidence in KNOWN_FIXES.get(bvid, []):
        apply("verified_ocr_spacing: " + evidence, value.replace(before, after))
    apply("remove_ellipsis", re.sub(r"…+|\.{3,}|⋯+", "", value))
    apply("remove_separate_filler", re.sub(r"(?<!\S)(?:呃+|额+|嗯+)(?!\S)", "", value))
    apply("remove_initial_eh", re.sub(r"(^|\s)呃+(?=[\u4e00-\u9fff0-9])", r"\1", value))
    # Restrict repetition edits to discourse starters; negations and claims stay.
    apply("collapse_discourse_stutter", re.sub(r"(我觉得|然后|就是)(?:\s*\1)+", r"\1", value))
    # Confirmation questions and lexical compounds are not modal filler.
    protected = re.compile(r"(?:对吧|是吧|酒吧|贴吧|网吧|氧吧)")
    placeholders = {}

    def protect(m):
        key = chr(0xE000 + len(placeholders))
        placeholders[key] = m.group()
        return key

    masked = protected.sub(protect, value)
    trimmed = re.sub(r"(?<=[\u4e00-\u9fff0-9])[啊呀啦呐吧]+(?=[\s，。！？；：,.!?;:]|$)", "", masked)
    for key, original in placeholders.items():
        trimmed = trimmed.replace(key, original)
    apply("trim_phrase_final_particles", trimmed)
    apply("normalize_spacing", re.sub(r"[ \t]+", " ", value).strip())
    apply("remove_orphan_punctuation", re.sub(r"^[，,；;]+", "", value))
    if not value.strip("，,。.!！?？ "):
        return text, []
    # These guards catch accidental deletions of seats, negation, or role names.
    assert re.sub(r"\D", "", text) == re.sub(r"\D", "", value)
    for term in ("不", "没", "未", "无", "别", "可能", "也许", "应该", "一定", "梅林", "派西", "莫甘", "莫德", "奥伯", "刺客", "忠臣"):
        assert text.count(term) == value.count(term), (term, text, value)
    return value, changes


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def overview(rows, quality):
    body = []
    for r in rows:
        bvid = r['bvid']
        body.append(f"""<tr><td>{r['index']}</td><td><a href="https://www.bilibili.com/video/{bvid}/">{html.escape(r['title'])}</a><small>{bvid} · {r['origin']}</small></td>
<td>{r['covered_through_mission']}</td><td>{r['recorded_mission_results']}</td><td>{r['team_blocks']}</td>
<td>{r['original_context_chars']:,}</td><td>{r['preprocess_context_chars']:,}</td><td>{r['cutoffs']}</td>
<td><a href="../yuanzhuo22-v1/inputs/{bvid}/full/input.zh.txt">原文</a> / <a href="inputs/{bvid}/full/input.zh.txt">清洗</a></td></tr>""")
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>圆桌谜局 · 22 局数据集</title><style>
:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:1500px;margin:auto;padding:32px}h1{font-size:30px;margin-bottom:4px}p{max-width:1050px}small{display:block;opacity:.65}a{color:LinkText}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:12px;border-bottom:1px solid GrayText;text-align:right}td:nth-child(2),th:nth-child(2){text-align:left;min-width:260px}thead{position:sticky;top:0;background:Canvas}th{white-space:nowrap}input{font:inherit;padding:10px;width:min(90%,480px);margin:16px 0}.scroll{overflow:auto}footer{margin-top:24px;font-size:14px}
</style><h1>圆桌谜局 · 22 局数据集</h1><small>preprocess-v1 · 2026-11-19 · 全部为 10 人局</small>
<p>包含原有 4 局与新增 18 局。范围是已核查的两份合集，排除宣传片；不代表 UP 主所有历史视频。
全文 22 份 + 阶段快照 90 份 = 每个版本 112 对 input / label。快照不是新增对局，也不一定与全文内容不同。</p>
<p><b>覆盖轮数</b>：记录覆盖到第几轮讨论；<b>结果轮数</b>：有明确任务结果的轮数。视频可能截断或缺少任务结果，不能把覆盖轮数当作完整对局长度。
<b>点车次数</b>：导出中的组队区块数，包括被否的车。<b>Context 字符数</b>：全文 input.zh.txt 的 Unicode 字符数，含空白、标点、规则及公开事件，不含单独的任务指令，也不是 token 数。</p>
<p>全文原文合计 <b>__RAW__</b> 字符；清洗后 <b>__CLEAN__</b> 字符。保留原文，清洗版不生成摘要，身份 label 不变。</p>
<label for="search">查找视频</label><br><input id="search" placeholder="输入标题、BV 号或“原有”"><span id="count">22 局</span>
<div class="scroll"><table><thead><tr><th>序号</th><th>视频</th><th>覆盖轮数</th><th>结果轮数</th><th>点车次数</th><th>原文字符</th><th>清洗字符</th><th>阶段快照</th><th>全文对照</th></tr></thead><tbody>__ROWS__</tbody></table></div>
<footer>清洗可能减少语气与停顿线索，不宣称语义完全无损。本次沿用原有转录校订，增加一处对照字幕确认的数字间隔修正；未重新逐字听写全部视频。<a href="full_text_changes.json">逐条修改记录</a> · <a href="statistics.json">统计数据</a> · <a href="quality.json">质量与限制</a></footer>
<script>document.querySelector('#search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();let n=0;document.querySelectorAll('tbody tr').forEach(r=>{r.hidden=!r.textContent.toLowerCase().includes(q);if(!r.hidden)n++});document.querySelector('#count').textContent=n+' 局'})</script></html>""".replace('__ROWS__', ''.join(body)).replace('__RAW__', f"{quality['original_full_chars']:,}").replace('__CLEAN__', f"{quality['preprocess_full_chars']:,}")


def main():
    base = HERE.parent / "data/video-benchmark"
    source = base / "releases/yuanzhuo22-v1"
    dest = base / "releases/yuanzhuo22-preprocess-v1"
    stage = dest.with_name(dest.name + ".staging")
    if dest.exists() or stage.exists():
        raise RuntimeError("Refusing to overwrite an existing derivative or staging directory")
    manifest = read(source / "manifest.json")
    original_hashes = {str(p.relative_to(source)): digest(p.read_bytes()) for p in source.rglob("*") if p.is_file()}
    stage.mkdir(parents=True)
    new_pairs, rules_count, full_changes = [], Counter(), []
    for pair in manifest["pairs"]:
        bvid = pair["bvid"]
        before = (source / pair["input_path"]).read_text(encoding="utf8")
        assert digest(before.encode()) == pair["input_sha256"]
        doc = read(source / pair["blocks_path"])
        new_doc = copy.deepcopy(doc)
        replacements, edits = [], []
        for block in new_doc["blocks"]:
            for i, speech in enumerate(block["speech"]):
                raw = speech["text"]
                cleaned, details = clean_speech(raw, bvid)
                who = f"{speech['seat']}号" if speech['seat'] is not None else "说话人未知"
                old_line, new_line = f"{who}：{raw}", f"{who}：{cleaned}"
                replacements.append((old_line, new_line))
                speech["text"] = cleaned
                if details:
                    edit = {"block_id": block["block_id"], "paragraph": i + 1, "seat": speech["seat"],
                            "before": raw, "after": cleaned, "steps": details}
                    edits.append(edit)
                    if pair["kind"] == "full":
                        rules_count.update(x["rule"].split(":")[0] for x in details)
                        full_changes.append({"bvid": bvid, **edit})
        # Assert that no public action, vote, or speaker attribution changed.
        for old_block, new_block in zip(doc["blocks"], new_doc["blocks"]):
            assert {k: v for k, v in old_block.items() if k != "speech"} == {k: v for k, v in new_block.items() if k != "speech"}
            assert [s["seat"] for s in old_block["speech"]] == [s["seat"] for s in new_block["speech"]]
        # Match complete original lines in order, so repeated speech is never
        # replaced in another speaker's paragraph or in an objective fact.
        lines = before.splitlines(keepends=True)
        at = 0
        for old, new in replacements:
            while at < len(lines) and lines[at].rstrip("\r\n") != old:
                at += 1
            assert at < len(lines), (pair["sample_id"], old)
            ending = "\n" if lines[at].endswith("\n") else ""
            lines[at] = new + ending
            at += 1
        after = "".join(lines)
        # Headers and objective records remain byte-identical. Version metadata
        # and the explicit preprocessing notice live in the task instruction.
        sid = pair["sample_id"] + "-pp1"
        new_pair = copy.deepcopy(pair)
        new_pair.update(sample_id=sid, parent_sample_id=pair["sample_id"], parent_input_sha256=pair["input_sha256"],
                        input_sha256=digest(after.encode()), preprocessing_version=VERSION)
        input_file = stage / pair["input_path"]
        input_file.parent.mkdir(parents=True, exist_ok=True)
        input_file.write_bytes(after.encode("utf8"))
        # Only after the public transformation is complete do we bind its answer.
        label = read(source / pair["label_path"])
        old_label = copy.deepcopy(label)
        label.update(sample_id=sid, input_sha256=new_pair["input_sha256"])
        assert label["seats"] == old_label["seats"] and label["optional_targets"] == old_label["optional_targets"]
        assert not record_errors(label), record_errors(label)
        assert not record_errors(new_doc), record_errors(new_doc)
        write_json(stage / pair["label_path"], label)
        write_json(stage / pair["blocks_path"], new_doc)
        write_json(stage / pair["audit_path"], {"schema": "vbench.preprocessing_audit/1", "version": VERSION,
                   "parent_sample_id": pair["sample_id"], "sample_id": sid, "parent_input_sha256": pair["input_sha256"],
                   "input_sha256": new_pair["input_sha256"], "parent_audit_path": str(source / pair["audit_path"]), "edits": edits})
        new_pair["label_sha256"] = digest((stage / pair["label_path"]).read_bytes())
        new_pair["size"].update(characters=len(after), utf8_bytes=len(after.encode()))
        new_pairs.append(new_pair)
        inst = stage / pair["instruction_path"]
        if not inst.exists():
            instruction = (source / pair["instruction_path"]).read_text(encoding="utf8")
            inst.parent.mkdir(parents=True, exist_ok=True)
            inst.write_text(instruction + "\n本样本为 preprocess-v1：玩家发言经过口癖和排版清理，不是逐字原话；未摘要、未补充推断，公开行动记录保持不变。\n", encoding="utf8")
    for rel, expected in original_hashes.items():
        assert digest((source / rel).read_bytes()) == expected
    rows = []
    full_by_bvid = {p["bvid"]: p for p in new_pairs if p["kind"] == "full"}
    old_full = {p["bvid"]: p for p in manifest["pairs"] if p["kind"] == "full"}
    old_runs = {"full-v2b", "game2-v1", "game3-v1", "game4-v1"}
    for index, game in enumerate(manifest["games"], 1):
        old, new = old_full[game["bvid"]], full_by_bvid[game["bvid"]]
        doc = read(source / old["blocks_path"])
        text = (source / old["input_path"]).read_text(encoding="utf8")
        results = {b["mission"]: b["mission_result"] for b in doc["blocks"] if b["mission_ran"] and b["mission_result"] is not None}
        rows.append({"index": index, "bvid": game["bvid"], "title": game["title"], "run_id": game["run_id"],
            "origin": "原有" if game["run_id"] in old_runs else "新增", "player_count": 10,
            "covered_through_mission": max(b["mission"] for b in doc["blocks"]),
            "recorded_mission_results": len(results), "mission_results": results,
            "team_blocks": len(doc["blocks"]), "original_context_chars": len(text),
            "original_nonwhitespace_chars": len(re.sub(r"\s", "", text)),
            "preprocess_context_chars": new["size"]["characters"], "cutoffs": game["pairs"] - 1,
            "full_input_original": str(source / old["input_path"]), "full_input_preprocess": str(dest / new["input_path"]),
            "tokens": None})
    quality = {"schema": "vbench.preprocessing_quality/1", "version": VERSION, "games": 22, "pairs": len(new_pairs),
        "original_files_unchanged": len(original_hashes), "labels_and_objective_facts_unchanged": True,
        "rules_counts_full_only": dict(rules_count), "changed_full_paragraphs": len(full_changes),
        "original_full_chars": sum(r["original_context_chars"] for r in rows),
        "preprocess_full_chars": sum(r["preprocess_context_chars"] for r in rows),
        "review_scope": "继承上一版本逐条纠错；本次增加一处看原字幕确认的数字间隔修正，并用确定规则清理全部112份输入。不是新一轮逐字听写或全文人工校对。",
        "limitations": ["语气词和停顿删除会损失部分语用线索，不能宣称语义完全无损。", "原始转录仍可能有漏字或错字；未自动猜测有歧义的座位数字。", "保留笑声、玩家重复的完整观点、改口、否定、模态词和对吧/是吧确认问句。", "全文覆盖轮数不等于完整真人对局轮数，未知后续不补造。", "字符数包括空白、标点、规则和公开事件，不含独立instruction；不是token数。"]}
    write_json(stage / "manifest.json", {**manifest, "schema": "vbench.collection_preprocess_release/1", "release_id": "yuanzhuo22-preprocess-v1", "parent_release": str(source), "pairs": new_pairs})
    write_json(stage / "quality.json", quality)
    write_json(stage / "statistics.json", {"metric": "Python len(input.zh.txt), including whitespace, excluding separate instruction", "games": rows, "summary": quality})
    write_json(stage / "full_text_changes.json", full_changes)
    (stage / "dataset-overview.html").write_text(overview(rows, quality), encoding="utf8")
    (stage / "README.md").write_text("# 圆桌谜局 preprocess-v1\n\n原文版本：../yuanzhuo22-v1。该版保留原文不动，生成22局、112对清洗样本，不生成摘要。\n\n清理省略号、独立呃/额/嗯、部分连续口头起句、短句末啊/呀/啦/呐/吧；保留对吧/是吧、笑声、模态词、否定、改口和完整观点的重复。每个样本只处理自己的公开文本，没有用后续剧情或身份答案决定清洗。\n\n沿用原版已经完成的转录纠错；新增一处有字幕截图证据的数字间隔修正。其余未能核实的疑似错字不猜。不是独立全文听写金标准。\n\n模型只读inputs内instruction.zh.txt及input.zh.txt。evaluator内label.json只用于评分，身份答案不变，样本ID及正文校验值已更新。audit.json记录每次清洗的前后文本及规则；旧证据通过parent_audit_path回溯。\n\nstatistics.json是22局统计，dataset-overview.html是可打开的表格。字符数包括正文中的空白、标点、规则和事件，不包括单独的任务指令，不是token数。覆盖至第几轮与实际记录了几轮任务结果分列，不能把剪辑长度当成真实对局长度。\n", encoding="utf8")
    write_json(stage / "sha256.json", {str(p.relative_to(stage)).replace("\\", "/"): digest(p.read_bytes()) for p in stage.rglob("*") if p.is_file()})
    stage.rename(dest)
    print(json.dumps(quality, ensure_ascii=False, indent=2))
    print(str(dest))


if __name__ == "__main__":
    main()
