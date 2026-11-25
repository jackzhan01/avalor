"""Audit the published NLU JSON files and make separate review-only projections."""
from __future__ import annotations

import hashlib
import html
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "data"
SOURCE = ROOT / "avalon-nlu/upstream/dataset"
DEST = ROOT / "avalon-nlu/review-2026-11-19"
EXPECTED = Counter(["merlin", "percival", "morgana", "assassin", "servant-1", "servant-2"])


def load(path):
    return json.loads(path.read_text(encoding="utf8"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def phase_end(message):
    text = message["msg"].strip().lower()
    return message["player"] == "system" and (text.startswith("good won for now") or "thus evil wins" in text or "forces of good win" in text or text.startswith("evil has failed three quests"))


def main():
    if DEST.exists():
        raise RuntimeError("Refusing to overwrite a dated audit")
    rows, evidence, totals = [], {}, Counter()
    hashes = {p.name: sha(p.read_bytes()) for p in SOURCE.glob("*.json")}
    for path in sorted(SOURCE.glob("*.json")):
        data = load(path)
        users = list(data["users"].values())
        assert len(users) == 6 and Counter(x["role"] for x in users) == EXPECTED
        assert sorted(x["index"] for x in users) == list(range(1, 7))
        assert {u["name"] for u in users} == {f"player-{i}" for i in range(1, 7)}
        # TinyDB table record IDs distinguish events even when a producer reuses mid.
        items = sorted(data["messages"].items(), key=lambda kv: int(kv[0]))
        assert [k for k, _ in items] == list(data["messages"])
        messages = [v for _, v in items]
        humans = [v for v in messages if v["player"] != "system"]
        assert all(v["player"] in {u["name"] for u in users} for v in humans)
        groups, annotations = defaultdict(list), defaultdict(list)
        for record_id, m in items:
            groups[m["mid"]].append({"record_id": record_id, **m})
        for record_id, a in data["persuasion"].items():
            annotations[a["mid"]].append({"record_id": record_id, **a})
        duplicate_mids = {k: v for k, v in groups.items() if len(v) > 1}
        duplicate_annotations = {k: v for k, v in annotations.items() if len(v) > 1}
        annotation_variants = {k: {json.dumps({kk: vv for kk, vv in a.items() if kk != "record_id"}, sort_keys=True) for a in v} for k, v in duplicate_annotations.items()}
        assert all(m["mid"] in annotations for m in humans)
        assert all(k in groups for k in annotations)
        # The preview ends before assassination or terminal announcements. It is
        # deliberately not yet a formal evaluation release or a translated text.
        boundary = next((i for i, m in enumerate(messages) if phase_end(m)), len(messages))
        public = items[:boundary]
        results = [(rid, m) for rid, m in public if m["player"] == "system" and re.fullmatch(r"quest (succeeded|failed)!", m["msg"].strip().lower())]
        completed = [m["quest"] for _, m in results]
        assert len(completed) == len(set(completed))
        assert completed == list(range(1, len(completed) + 1))
        unknown_leaders = [{"record_id": rid, **m} for rid, m in items if m["player"] == "system" and "proposed a party" in m["msg"] and not re.match(r"player-[1-6] proposed a party:", m["msg"])]
        bad_votes = []
        for rid, m in public:
            if m["player"] == "system" and m["msg"].startswith("party vote outcome:"):
                votes = re.findall(r"player-([1-6]): (yes|no)", m["msg"])
                if sorted(seat for seat, _ in votes) != list("123456"):
                    bad_votes.append(rid)
        preview = "Avalon NLU: public-message review preview, not a frozen benchmark release.\nPlayers: 1–6. Roles in play: Merlin, Percival, Morgana, Assassin, two Servants.\nPlayer statements are claims, not verified identities. Source record IDs preserve order.\n\n"
        preview += "\n".join(f"[{rid}; quest={m['quest']}; turn={m['turn']}] {m['player']}: {m['msg']}" for rid, m in public) + "\n"
        preview_path = DEST / "inputs" / path.stem / "public-preview.en.txt"
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview_path.write_text(preview, encoding="utf8")
        label = {"status": "review_only", "source_file": path.name,
                 "roles": {str(u["index"]): "servant" if u["role"].startswith("servant-") else u["role"] for u in users},
                 "original_roles": {str(u["index"]): u["role"] for u in users},
                 "note": "Keep out of model input. servant-1 and servant-2 have the same game role and are scored as servant."}
        save(DEST / "evaluator" / path.stem / "label-preview.json", label)
        row = {"game_id": path.stem, "players": len(users), "recorded_quest_results": len(results),
               "max_quest_field": max(m["quest"] for m in messages), "human_messages": len(humans), "system_messages": len(messages) - len(humans),
               "annotations": len(data["persuasion"]), "beliefs": len(data.get("beliefs", {})), "beliefs_table_present": "beliefs" in data,
               "public_preview_chars": len(preview), "duplicate_mid_groups": len(duplicate_mids),
               "duplicate_annotation_extra_rows": sum(len(v) - 1 for v in duplicate_annotations.values()),
               "conflicting_annotation_mid_groups": sum(len(v) > 1 for v in annotation_variants.values()),
               "unknown_leader_events": len(unknown_leaders), "malformed_public_vote_events": len(bad_votes),
               "excluded_end_messages": len(items) - boundary,
               "source_sha256": hashes[path.name]}
        rows.append(row)
        evidence[path.stem] = {"duplicate_message_mids": duplicate_mids, "duplicate_annotations": duplicate_annotations,
                              "unknown_leader_events": unknown_leaders, "malformed_public_vote_record_ids": bad_votes,
                              "excluded_end_messages": [{"record_id": rid, **m} for rid, m in items[boundary:]],
                              "result_record_ids": [rid for rid, _ in results]}
        totals.update(games=1, players=len(users), human_messages=len(humans), system_messages=len(messages)-len(humans),
                      annotations=len(data["persuasion"]), belief_records=len(data.get("beliefs", {})), quest_results=len(results),
                      duplicate_annotation_extra_rows=row["duplicate_annotation_extra_rows"], conflicting_annotation_mid_groups=row["conflicting_annotation_mid_groups"],
                      games_with_duplicate_mids=bool(duplicate_mids), games_without_beliefs="beliefs" not in data,
                      public_preview_characters=len(preview), malformed_public_vote_events=len(bad_votes))
    assert all(sha((SOURCE / name).read_bytes()) == value for name, value in hashes.items())
    video = ROOT / "video-benchmark/releases/yuanzhuo22-preprocess-v1"
    requests = defaultdict(list)
    for p in load(video / "manifest.json")["pairs"]:
        key = sha((video / p["instruction_path"]).read_bytes() + b"\x00" + (video / p["input_path"]).read_bytes())
        requests[key].append(p["sample_id"])
    request_plan = {"release": str(video), "pair_count": sum(map(len, requests.values())), "unique_instruction_and_input_requests": len(requests),
                    "assumption": "one model, one fixed configuration, one draw per distinct input; retries and repeat runs are extra",
                    "groups": [{"prompt_hash": key, "sample_ids": ids} for key, ids in requests.items()]}
    report = {"date": "2026-11-19", "source": "https://github.com/sstepput/Avalon-NLU", "source_commit": "5d69036c22cf57be45877182f80b65b93e5d33f6",
              "scope": "all 20 JSON files structurally checked; source code and selected message/annotation examples reviewed; not a full human semantic relabeling",
              "totals": dict(totals), "quest_distribution": dict(Counter(r["recorded_quest_results"] for r in rows)), "games": rows,
              "findings": ["All games have six complete role labels; normalize the two servant IDs to the same role for scoring.",
              "All human message IDs have strategy annotations; all annotations resolve to messages. Some exact annotation duplicates exist; see evidence.",
              "mid is not a unique event key: preserve TinyDB record ID order and never deduplicate system events by mid.",
              "quest includes terminal/assassination phase numbering; count actual quest-result messages instead of max(quest).",
              "users.role, beliefs and persuasion/deception labels are evaluator-only, not observer input.",
              "The published four-table JSON files do not expose per-seat quest cards or numeric fail-card counts as structured fields. Do not invent them.",
              "3YjxjN has a post-victory party event with leader ###; excluded from public review preview.",
              "Keep English original speech. Comparing this six-player online corpus with ten-player Chinese video confounds player count, language and medium.",
              "This is a public 2023 corpus: unseen-by-model status cannot be guaranteed."]}
    save(DEST / "audit.json", report)
    save(DEST / "audit-evidence.json", evidence)
    save(DEST / "video-request-plan.json", request_plan)
    table = []
    for r in rows:
        gid = r["game_id"]
        flags = []
        if not r["beliefs_table_present"]: flags.append("无 beliefs")
        if r["duplicate_mid_groups"]: flags.append("mid 重复")
        if r["duplicate_annotation_extra_rows"]: flags.append(f"多余标注 {r['duplicate_annotation_extra_rows']}")
        if r["unknown_leader_events"]: flags.append("终局后未知车主")
        table.append(f"<tr><td>{gid}</td><td>{r['recorded_quest_results']}</td><td>{r['human_messages']}</td><td>{r['system_messages']}</td><td>{r['annotations']}</td><td>{r['public_preview_chars']:,}</td><td>{'；'.join(flags) or '—'}</td><td><a href='inputs/{gid}/public-preview.en.txt'>公开文本</a> / <a href='evaluator/{gid}/label-preview.json'>答案</a></td></tr>")
    page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avalon NLU 数据审核</title>
<style>:root{font:16px/1.6 system-ui,sans-serif;color-scheme:light dark}body{max-width:1250px;margin:auto;padding:30px}h1{font-size:28px}p{max-width:1000px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:10px;border-bottom:1px solid GrayText;text-align:right}td:first-child,td:nth-last-child(2){text-align:left}a{color:LinkText}.scroll{overflow:auto}small{opacity:.7}</style>
<h1>Avalon NLU · 数据审核</h1><small>2026-11-19 · 来源：sstepput/Avalon-NLU · 本地 commit 5d69036</small>
<p><b>20 局，全部 6 人局；2,384 条真人发言，519 条系统消息，82 次任务结果。</b>身份齐全：梅林、派西维尔、莫甘娜、刺客、两名忠臣。公开原文为英文在线聊天。逐文件结构检查已完成，未做全部发言的人工语义重标注。</p>
<p>原始 JSON 混合了公开消息与评分信息。模型输入应只包含公开聊天、点车、座位级票型和任务结果；users.role、beliefs、persuasion/deception 均单独保留。两名忠臣应统一成 servant 评分，不能要求模型区分 servant-1/2。</p>
<p>轮数按实际任务结果计数，不取 max(quest)。mid 在部分系统事件中重复，必须用原始表记录 ID 保序，不能按 mid 去重。三个文件存在重复策略标注；一局没有 beliefs，一局终局后还有未知车主的点车日志。详情见审核 JSON。</p>
<p>下方链接是<b>审核预览，尚不是正式评测集</b>：公开文本保留英文和原始顺序，截在刺杀或终局提示之前；答案另存。字符数含预览说明、记录编号及换行，未计算 token。原始文件未修改。</p>
<div class="scroll"><table><thead><tr><th>对局</th><th>任务轮数</th><th>真人发言</th><th>系统消息</th><th>标注条数</th><th>预览字符</th><th>需注意</th><th>人工审核</th></tr></thead><tbody>__ROWS__</tbody></table></div>
<p><a href="audit.json">完整审核统计</a> · <a href="audit-evidence.json">异常与引用证据（含评测信息）</a> · <a href="video-request-plan.json">圆桌谜局请求去重清单</a></p>
<p>圆桌谜局 preprocess-v1：112 对样本、99 组不同的“指令＋正文”。一次模型配置、每个唯一输入抽样一次，需要99次成功请求；重试与重复实验另算。game22 的 v2-review 未混入这份清单。</p></html>""".replace("__ROWS__", "".join(table))
    (DEST / "overview.html").write_text(page, encoding="utf8")
    save(DEST / "sha256.json", {p.relative_to(DEST).as_posix(): sha(p.read_bytes()) for p in DEST.rglob("*") if p.is_file()})
    print(json.dumps({"totals": dict(totals), "quest_distribution": report["quest_distribution"], "unique_video_requests": len(requests), "report": str(DEST / "overview.html")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
