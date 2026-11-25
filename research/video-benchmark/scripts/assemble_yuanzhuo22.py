"""Validate frozen reviewed exports and assemble a separated local release."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from vbench.validate import record_errors  # noqa: E402

RELEASES = [
    ("BV19D7565EZg", "full-v2b", "agent_pairs_v3"),
    ("BV17y756nE1m", "game7-v1", "agent_pairs_v3"),
    ("BV1bGTy6tEj8", "game8-v1", "agent_pairs_v3"),
    ("BV1M2M562EeM", "game9-v1", "agent_pairs_v3"),
    ("BV1mzNd6QEN8", "game10-v1", "agent_pairs_v3"),
    ("BV1WB316PEig", "game11-v1", "agent_pairs_v3"),
    ("BV1kr876AEE1", "game3-v1", "agent_pairs_v3"),
    ("BV1dc8F6qE5K", "game4-v1", "agent_pairs_v3_r1"),
    ("BV1pYtc6mEcd", "game5-v2", "agent_pairs_v3"),
    ("BV1ypYT6jEyy", "game6-v1", "agent_pairs_v3"),
    ("BV12beJ69E8W", "game2-v1", "agent_pairs_v3_r1"),
    ("BV1ufaA6GEwk", "game12-v1", "agent_pairs_v3"),
    ("BV13oaN6HE1y", "game13-v1", "agent_pairs_v3"),
    ("BV1AApJ6pEY4", "game14-v1", "agent_pairs_v3"),
    ("BV1hAJX6SEVp", "game15-v2", "agent_pairs_v3"),
    ("BV1aann6eErr", "game16-v1", "agent_pairs_v3"),
    ("BV1ianm6EE7h", "game17-v1", "agent_pairs_v3"),
    ("BV1MfxT6TEJS", "game18-v1", "agent_pairs_v3"),
    ("BV1AaxC6hEhz", "game19-v1", "agent_pairs_v3_r1"),
    ("BV1X34B6YEhK", "game20-v1", "agent_pairs_v3"),
    ("BV1E4W16REGX", "game21-v1", "agent_pairs_v3"),
    ("BV1SEs56XE3r", "game22-v1", "agent_pairs_v3"),
]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--allow-incomplete", action="store_true")
    args = ap.parse_args()
    if args.allow_incomplete and not args.check_only:
        ap.error("--allow-incomplete requires --check-only")
    base = HERE.parent / "data/video-benchmark"
    scope = read(base / "sources/yuanzhuo.scope.2026-11-18.json")
    by_bvid = {v["bvid"]: v for v in scope["videos"]}
    assert set(by_bvid) == {b for b, _, _ in RELEASES}
    problems, missing, games, pairs, copies, legacy_conflicts = [], [], [], [], [], []
    configs = [read(p) for p in (HERE / "configs").glob("*.json")]
    totals = Counter()
    seen_ids = set()
    full_hashes = set()
    for bvid, run, folder in RELEASES:
        root = base / "runs" / run / folder
        if not (root / "manifest.json").is_file():
            missing.append(bvid)
            continue
        manifest = read(root / "manifest.json")
        problems += [f"{run}: {e}" for e in record_errors(manifest)]
        cfgs = [c for c in configs if c.get("run_id") == run]
        if len(cfgs) != 1:
            problems.append(f"{run}: expected exactly one frozen config, found {len(cfgs)}")
            continue
        cfg = cfgs[0]
        if len(manifest["pairs"]) != 1 + len(cfg.get("cutoffs", [])):
            problems.append(f"{run}: missing or unexpected cutoffs")
        report = read(base / "runs" / run / "views/build_report.json")
        for key in ("stale", "invalid_after_apply"):
            if report.get(key):
                problems.append(f"{run}: nonempty build report {key}")
        # Frozen legacy exports retain rejected duplicate corrections. Audit the
        # precise difference rather than rewriting their history or ignoring it.
        if report.get("conflicts"):
            corrections = {}
            for path in report["correction_files"]:
                for line in Path(path).read_text(encoding="utf-8").splitlines():
                    c = json.loads(line)
                    corrections[c["correction_id"]] = c
            for conflict in report["conflicts"]:
                prior = re.search(r"by (cor-[a-f0-9]+)", conflict["reason"])
                newer = corrections[conflict["correction_id"]]
                older = corrections.get(prior.group(1)) if prior else None
                duplicate = older and all(newer.get(k) == older.get(k) for k in ("target", "op", "path", "value"))
                trailing_comma = (older and run == "game3-v1"
                    and newer.get("op") == older.get("op") == "set"
                    and newer.get("path") == older.get("path") == "caption.text"
                    and newer["target"] == older["target"]
                    and older["value"] == newer["value"] + "，")
                if (run == "full-v2b" and duplicate and newer["op"] == "accept") or trailing_comma:
                    legacy_conflicts.append({"run_id": run, **conflict,
                        "disposition": "duplicate_accept" if duplicate else "retained_trailing_comma"})
                else:
                    problems.append(f"{run}: unresolved correction {conflict['correction_id']}")
        source_id = manifest["generated_from"]["source_id"]
        game = {"bvid": bvid, "title": by_bvid[bvid]["title"], "url": by_bvid[bvid]["url"],
                "run_id": run, "pair_directory": folder, "source_id": source_id,
                "game_id": manifest["generated_from"]["game_id"], "player_count": 10,
                "live_interval": cfg["interval"], "pairs": len(manifest["pairs"]),
                "review_status": "provisional_self_review", "status": "exported_and_validated"}
        games.append(game)
        copies.append((root / "instruction.zh.txt", f"inputs/{bvid}/instruction.zh.txt"))
        copies.append((root / "manifest.json", f"evaluator/{bvid}/source_manifest.json"))
        coverage = base / "annotations" / source_id / "coverage.json"
        if coverage.is_file():
            copies.append((coverage, f"evaluator/{bvid}/coverage.json"))
        hashes_in_game = set()
        role_map = None
        for p in manifest["pairs"]:
            sid = p["sample_id"]
            if sid in seen_ids:
                problems.append(f"duplicate sample_id {sid}")
            seen_ids.add(sid)
            label = read(root / p["label_path"])
            blocks = read(root / p["blocks_path"])
            audit = read(root / p["audit_path"])
            for doc in (label, blocks, audit):
                problems += [f"{run}/{sid}: {e}" for e in record_errors(doc)]
            for name in ("input", "label"):
                if sha(root / p[f"{name}_path"]) != p[f"{name}_sha256"]:
                    problems.append(f"{run}/{sid}: {name} hash mismatch")
            if label["input_sha256"] != p["input_sha256"] or label["sample_id"] != sid:
                problems.append(f"{run}/{sid}: label pairing mismatch")
            if label.get("draft") or p["dataset"] != "accepted":
                problems.append(f"{run}/{sid}: draft in release")
            if set(label["seats"]) != {str(s) for s in range(1, 11)}:
                problems.append(f"{run}/{sid}: incomplete ten-seat label")
            if any(s["verification"] != "verified" for s in label["seats"].values()):
                problems.append(f"{run}/{sid}: unverified identity")
            if role_map is not None and role_map != label["seats"]:
                problems.append(f"{run}/{sid}: identity changes between cutoffs")
            role_map = label["seats"]
            for block in blocks["blocks"]:
                votes = block.get("votes")
                seats = [s for v in votes.values() for s in v] if votes else []
                if votes and sorted(seats) != list(range(1, 11)):
                    problems.append(f"{run}/{sid}/{block['block_id']}: incomplete vote vector")
            rel = "full" if p["kind"] == "full" else f"cutoffs/{sid}"
            dest_input = f"inputs/{bvid}/{rel}/input.zh.txt"
            dest_label = f"evaluator/{bvid}/{rel}/label.json"
            copies.extend([(root / p["input_path"], dest_input),
                           (root / p["label_path"], dest_label),
                           (root / p["audit_path"], f"evaluator/{bvid}/{rel}/audit.json"),
                           (root / p["blocks_path"], f"evaluator/{bvid}/{rel}/blocks.json")])
            pairs.append({**p, "bvid": bvid, "run_id": run,
                          "instruction_path": f"inputs/{bvid}/instruction.zh.txt",
                          "input_path": dest_input, "label_path": dest_label,
                          "audit_path": f"evaluator/{bvid}/{rel}/audit.json",
                          "blocks_path": f"evaluator/{bvid}/{rel}/blocks.json"})
            totals[p["kind"]] += 1
            hashes_in_game.add(p["input_sha256"])
            if p["kind"] == "full":
                full_hashes.add(p["input_sha256"])
                totals["full_characters"] += p["size"]["characters"]
                totals["full_speech_paragraphs"] += p["size"]["speech_lines"]
                totals["full_team_blocks"] += p["size"]["blocks"]
                totals["verified_seat_labels"] += len(label["seats"])
                game["roles"] = dict(Counter(s["role"] for s in label["seats"].values()))
                game["final_outcome"] = label["optional_targets"]
        game["distinct_inputs"] = len(hashes_in_game)
    if len(full_hashes) != len(games):
        problems.append("duplicate full input bytes across videos")
    totals["games"] = len(games)
    totals["pairs"] = len(pairs)
    totals["distinct_input_bytes"] = len({p["input_sha256"] for p in pairs})
    quality = {"schema": "vbench.collection_quality/1", "totals": dict(totals),
               "missing": missing, "errors": problems, "legacy_correction_conflicts": legacy_conflicts,
               "checks": ["schema and semantic validation", "input/label SHA-256",
                          "ten verified seats per game", "stable identity across cutoffs",
                          "all requested cutoffs present", "complete recorded vote vectors",
                          "no stale/invalid corrections; legacy conflicts audited individually", "unique full-input bytes"],
               "limitations": [
                   "22个视频正片来自已核实的两个合集，不保证未来新上传会自动加入。",
                   "字幕为OCR与本地ASR对照，加视觉疑点复核；未独立全程听写，不保证发言召回率。",
                   "剪辑缺口、身份未知或终局未知不补猜；full是已保留现场区间的全文，不含盘刀和赛后。",
                   "数据由同一流程自审，状态为provisional_self_review，未经过独立第二标注者复核。",
                   "全文与最后截止点可能字节相同，不能把各截止点当独立对局。",
                   "同一局所有截止点必须在同一数据划分；跨局常见同一玩家，尚未完成按玩家去重的划分。",
                   "BV1AApJ6pEY4和BV1hAJX6SEVp使用执剑者/破壁者变体，见逐局角色组成；不可统一套标准角色表。",
                   "BV1AaxC6hEhz第二轮第一车的播报与板面冲突，取板面及后续玩家复述1/4/5/9并保留board_conflict；严格车队事实评测应排除该事件。",
                   "玩家原话可能含昵称、自称身份、谎话及源字幕错字，按原话保留。",
               ]}
    print(json.dumps(quality, ensure_ascii=False, indent=2))
    if problems or (missing and not args.allow_incomplete):
        return 1
    if args.check_only:
        return 0
    dest = base / "releases/yuanzhuo22-v1"
    stage = dest.with_name(dest.name + ".staging")
    if dest.exists() or stage.exists():
        raise RuntimeError("Refusing to overwrite an existing release or staging directory")
    stage.mkdir(parents=True)
    file_hashes = {}
    for src, rel in copies:
        target = stage / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
        file_hashes[rel] = sha(target)
        if file_hashes[rel] != sha(src):
            raise RuntimeError(f"copy hash mismatch: {rel}")
    write = lambda rel, obj: (stage / rel).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write("manifest.json", {"schema": "vbench.collection_release/1", "release_id": "yuanzhuo22-v1", "scope_as_of": scope["as_of"], "games": games, "pairs": pairs})
    write("quality.json", quality)
    write("sha256.json", file_hashes)
    reviewed = {g["bvid"]: g for g in games}
    write("source_scope.json", {**scope,
        "scope": "截至清单日期已核实的两个合集内全部22个十人局正片；不声称覆盖合集外所有上传。",
        "videos": [{**v, "player_count": 10,
                    "player_count_basis": "per_video_ten_seat_source_review",
                    "status": "exported_and_validated",
                    "release": [reviewed[v["bvid"]]["run_id"], reviewed[v["bvid"]]["pair_directory"]]}
                   for v in scope["videos"]]})
    intro = f"""# 圆桌谜局：22局十人阿瓦隆视频数据

已提取 {totals['games']} 局，{totals['full']} 份全文和 {totals['cutoff']} 份截止点，共 {totals['pairs']} 对 input/label。不同输入字节共 {totals['distinct_input_bytes']} 份，全文与最后截止点相同的情况保留，不算额外对局。

模型只读取 `manifest.json` 中每条样本指向的 `instruction_path` 和 `input_path`。答案由评测程序另读 `label_path`，不可发送 evaluator 文件夹或整个发布目录。inputs 文件夹仅含指令和正文；evaluator 放身份答案、可追溯审计和结构化记录。

正文沿用以前的 `input.zh.txt` 格式，按点车分段，保留玩家原话、车队、完整座位票型、车过/车被否和任务总结果。每局的 full 指保留的现场区间全文，排除片头私密介绍、正式盘刀和赛后。已验证的身份答案共 {totals['verified_seat_labels']} 个座位。

先看 `quality.json` 的局限与已知冲突，再设计评测。同一局的全文和截止点不能跨 train/test。状态为 provisional_self_review；这是可审计的研究初版，不是独立人工全程听写金标准。

原始证据和逐次修正仍保留在 research/data/video-benchmark/runs 与 annotations；发布文件都是现有已审阅导出的字节复制，没有压缩或重写玩家发言。`sha256.json` 可验证每个复制文件。
"""
    (stage / "README.md").write_text(intro, encoding="utf-8")
    stage.rename(dest)
    print(str(dest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
