"""Build the input/label pairs an evaluator actually sends and scores.

Everything here is a projection of the already-reviewed public record: the
blocks come from `assemble()` → `build_blocks()`, exactly as the archival
timeline does, so the document and the audit layer cannot disagree about a
fact. Labels come from the private roster through `private_labels`, are written
to their own files, and never touch the document builder.

Cutoff safety is structural: a cutoff prunes the *atoms* first and blocks are
built from that prefix, so a later team selection, tally or mission result has
no path into an earlier document.
"""

from __future__ import annotations

from pathlib import Path

from .block_text import blocks_document, render_input, speech_lines
from .blocks import block_accounting, build_blocks
from .paths import annotation_paths, run_paths
from .samples import CutoffError, check_perspective, resolve_cutoff
from .timeline import OBJECTIVE_EVENT_TYPES, TurnConfig, assemble, load_boundary_decisions, load_coverage, select_atoms
from .util import canonical_json, read_json, read_jsonl, sha256_bytes, write_bytes, write_json
from .validate import ValidationFailed, agent_blocks_errors, input_text_errors, record_errors

INSTRUCTION_ZH = """你将读到一份《阿瓦隆》对局的公开记录，按每次组队分段，包含玩家原话和每次组队的客观结果。

请只根据这份记录推断每个座位的真实身份。

要求：
- 对 1 号到 10 号每个座位各给一个身份，取值只能是：梅林、派西维尔、忠臣、莫甘娜、莫德雷德、刺客、奥伯伦。
- 身份数量必须符合开局构成；不确定也要给出最可能的身份，不要留空。
- 输出 JSON，形如 {"1": "忠臣", "2": "梅林", ...}，不要输出其它内容。
"""


def sample_id_v3(game_id: str, run_id: str, dataset: str, perspective: str, cutoff_sequence: int | None,
                 revision: str = "") -> str:
    key = f"p3|{game_id}|{run_id}|{dataset}|{perspective}|{'' if cutoff_sequence is None else cutoff_sequence}"
    if revision:
        key += f"|{revision}"
    return ("p3full-" if cutoff_sequence is None else "p3-") + sha256_bytes(key.encode())[:16]


def pairs_dir_name(revision: str = "") -> str:
    return "agent_pairs_v3" if not revision else f"agent_pairs_v3_{revision}"


def _pair_paths(cfg: dict, dataset: str, root: Path | None, revision: str = ""):
    run = run_paths(cfg["run_id"], root)
    base = run.root / pairs_dir_name(revision)
    return base if dataset == "accepted" else base / "draft"


def assumed_rules(cfg_rules: dict) -> list[dict]:
    """Rules the config carries but this video never showed, with their basis.

    They are omitted from the rendered input and kept here instead, so the
    assumption stays on the record without being asserted to a model as fact.
    """
    basis = cfg_rules.get("basis") or {}
    return [{"key": k, "value": cfg_rules.get(k), "basis": basis.get(k, "（配置未记录来源）"),
             "omitted_from_input": True}
            for k in sorted(set(cfg_rules.get("unverified") or ()))]


def _load_public(cfg: dict, source_id: str, root: Path | None) -> dict:
    from .timeline_build import timeline_paths

    tp = timeline_paths(cfg, source_id, root)
    spk = run_paths(cfg["run_id"], root).public / "speaker_segments.jsonl"
    return {
        "utterances": read_jsonl(tp["views_all"] / "utterances.jsonl"),
        "events": read_jsonl(tp["views_all"] / "events.jsonl"),
        "coverage": load_coverage(tp["coverage"]),
        "decisions": load_boundary_decisions(tp["boundaries"]),
        "nicknames": sorted({s["name"] for s in read_jsonl(spk) if s.get("name")}),
    }


def nickname_mentions(text: str, nicknames: list[str]) -> list[str]:
    """Player nicknames that survive inside original speech.

    Reported, never stripped: a name someone actually said is part of the
    contribution, and rewriting it would falsify the record. The evaluator
    decides whether a mention matters for de-identification.
    """
    return sorted({n for n in nicknames if len(n) >= 2 and n in text})


def build_document(pub: dict, cfg: dict, dataset: str, cutoff_sequence: int | None = None) -> dict:
    """Blocks + rendered text for the whole record, or for a cutoff prefix."""
    coverage = pub["coverage"]
    live = (coverage or {}).get("live_game_interval")
    atoms, sel = select_atoms(pub["utterances"], pub["events"], dataset, live[1] if live else None)
    gaps = [g for g in (coverage or {}).get("gaps", []) if cfg["interval"]["start"] <= g["start"] < cfg["interval"]["end"]]
    t_cut = None
    if cutoff_sequence is not None:
        by_seq = {a["seq"]: a for a in atoms if a["kind"] != "excluded"}
        if cutoff_sequence not in by_seq:
            raise CutoffError(f"cutoff sequence {cutoff_sequence} is not an eligible {dataset} record")
        t_cut = by_seq[cutoff_sequence]["public_at"]
        atoms = [a for a in atoms if a["seq"] <= cutoff_sequence and a["public_at"] <= t_cut + 1e-9]
        gaps = [g for g in gaps if g["start"] <= t_cut]
    late = {k: g["gap_id"] for g in gaps for k in g["late_reported_event_keys"]}
    items, _ = assemble(atoms, gaps, {}, pub["decisions"], TurnConfig.from_dict(cfg.get("turns")), late, until_public_at=t_cut)
    blocks, bstats = build_blocks(items, cfg["rules"])
    errs = block_accounting(blocks, items)
    doc = blocks_document(blocks, cfg["rules"])
    text = render_input(doc)
    return {"items": items, "blocks": blocks, "doc": doc, "text": text, "errors": errs,
            "selection": sel, "block_stats": bstats, "cutoff_public_at": t_cut}


def excluded_records(pub: dict, cfg: dict, dataset: str, kept_segments: set[str], kept_events: set[str]) -> list[dict]:
    """Every in-interval record no block carries, grouped by why.

    Counted against the views rather than against the selector's own tally, so a
    record cannot disappear from both the document and this list.
    """
    lo, hi = cfg["interval"]["start"], cfg["interval"]["end"]
    live = (pub["coverage"] or {}).get("live_game_interval")
    buckets: dict[str, list[str]] = {}

    def add(reason: str, rid: str) -> None:
        buckets.setdefault(reason, []).append(rid)

    for u in pub["utterances"]:
        cap = u.get("caption")
        start = cap["display_start"] if cap else u["asr"].get("audio_start")
        if start is None or not (lo <= start < hi) or u["utterance_id"] in kept_segments:
            continue
        why = []
        if u["review_status"] == "rejected":
            why.append("审阅拒绝：重复显示或动画残影，不是第二句话")
        if live and start >= live[1]:
            why.append("live_game_interval 之外：赛后交谈，不属于对局中的公开信息")
        if u["eligibility"] != "in_game_speech" and not (dataset == "draft" and u["eligibility"] == "unknown"):
            why.append(f"资格为 {u['eligibility']}：不是对局中的发言")
        if u["availability"]["status"] != "anchored" or u.get("sequence") is None:
            why.append("没有锚定到公开时刻，无法定位在顺序里")
        if u["review_status"] not in ("rejected", "accepted"):
            why.append(f"本数据集（{dataset}）不收未审阅候选")
        add("；".join(why) or "未纳入，原因未归类（需要复核）", u["utterance_id"])
    for e in pub["events"]:
        if e["event_id"] in kept_events:
            continue
        why = []
        if e["review_status"] == "rejected":
            why.append("审阅拒绝：板面淡入动画造出的半成品行，不是一次真实事件")
        if e["type"] not in OBJECTIVE_EVENT_TYPES:
            why.append("语义事件：本版范围之外，从不渲染")
        if e["availability"]["status"] != "anchored" or e.get("sequence") is None:
            why.append("没有锚定到公开时刻，无法定位在顺序里")
        if e["review_status"] not in ("rejected", "accepted"):
            why.append(f"本数据集（{dataset}）不收未审阅候选")
        add("；".join(why) or "未纳入，原因未归类（需要复核）", e["event_id"])
    return [{"reason": r, "count": len(ids), "ids": sorted(ids)} for r, ids in sorted(buckets.items())]


def _audit(built: dict, *, sample_id: str, dataset: str, cfg: dict, cutoff: dict | None, input_sha: str,
           excluded: list[dict], open_questions: list[str]) -> dict:
    from .block_text import coverage_line

    blocks = []
    for b in built["blocks"]:
        seq_by_item = {i["item_id"]: i["source_sequences"] for i in b["audit"]["items"]}
        blocks.append({
            "block_id": b["block_id"], "mission": b["mission"], "attempt": b["attempt"],
            "forced": b["forced"], "forced_basis": b["forced_basis"],
            "paragraphs": [{
                "line": n, "seat": p["seat"], "item_ids": p["item_ids"], "segment_ids": p["segment_ids"],
                "source_sequences": sorted(s for i in p["item_ids"] for s in seq_by_item.get(i, [])),
            } for n, p in enumerate(b["speech"], 1)],
            "events": b["audit"]["events"], "gaps": b["audit"]["gaps"], "conflicts": b["audit"]["conflicts"],
        })
    return {
        "schema": "vbench.agent_pair_audit/1",
        "sample_id": sample_id,
        "dataset": dataset,
        "run_id": cfg["run_id"],
        "cutoff": cutoff,
        "input_sha256": input_sha,
        "blocks": blocks,
        "excluded": excluded,
        "rules_assumed": assumed_rules(cfg["rules"]),
        "coverage_statement": coverage_line(built["doc"]["blocks"]),
        "open_questions": open_questions,
    }


def _revision_of(out_root: Path, base_root: Path, pairs: list[dict], reason: list[str]) -> dict | None:
    """Map every new sample back to the one it revises, by kind and cutoff label.

    Reads the superseded manifest only; the old directory is never written to.
    """
    old_manifest = base_root / "manifest.json"
    old_pairs = read_json(old_manifest)["pairs"] if old_manifest.exists() else []
    by_key = {(p["kind"], p.get("cutoff_label")): p for p in old_pairs}
    rows = []
    for p in pairs:
        prev = by_key.get((p["kind"], p.get("cutoff_label")))
        rows.append({
            "kind": p["kind"], "cutoff_label": p.get("cutoff_label"),
            "old_sample_id": prev["sample_id"] if prev else None,
            "new_sample_id": p["sample_id"],
            "old_input_sha256": prev["input_sha256"] if prev else None,
            "new_input_sha256": p["input_sha256"],
        })
    return {"dir": base_root.name, "reason": reason, "sample_id_map": rows}


def build_agent_pairs(cfg: dict, source: dict, dataset: str = "accepted", root: Path | None = None,
                      perspective: str = "public_observer", roster_path: Path | None = None,
                      open_questions: list[str] | None = None, revision: str = "",
                      revision_reason: list[str] | None = None) -> dict:
    from .private_labels import build_label_v3, load_roster_v2
    from .source import load_manifest

    check_perspective(perspective)
    pub = _load_public(cfg, source["source_id"], root)
    ann = annotation_paths(source["source_id"], root)
    roster_path = roster_path or (ann.root / "private" / "roster_v2.json")
    roster = load_roster_v2(roster_path) if roster_path.exists() else None

    manifest = load_manifest(root)
    game = next(g for g in manifest["games"] if g["game_id"] == source["game_id"])
    src_cfg = cfg["source"]
    forbidden = [source["source_id"], source["video_sha256"], game["game_id"], game["group_id"],
                 src_cfg.get("bvid"), src_cfg.get("url"), src_cfg.get("aid"), src_cfg.get("cid"),
                 src_cfg.get("title"), src_cfg.get("uploader"), cfg["run_id"]]
    forbidden = [str(s) for s in forbidden if s]

    out_root = _pair_paths(cfg, dataset, root, revision)
    questions = list(open_questions or [])
    pairs: list[dict] = []
    mentions: dict[str, list[str]] = {}

    def emit(kind: str, built: dict, cutoff: dict | None, rel_dir: str) -> dict:
        sid = sample_id_v3(game["game_id"], cfg["run_id"], dataset, perspective,
                           cutoff["sequence"] if cutoff else None, revision)
        errs = record_errors(built["doc"], "agent_blocks", forbidden_strings=forbidden) + built["errors"]
        errs += input_text_errors(built["text"], forbidden)
        if errs:
            raise ValidationFailed([f"{rel_dir}: {m}" for m in errs[:20]])
        text_bytes = built["text"].encode("utf-8")
        input_sha = sha256_bytes(text_bytes)
        hits = nickname_mentions(built["text"], pub["nicknames"])
        if hits:
            mentions[rel_dir] = hits
        label = build_label_v3(roster, sid, input_sha, dataset)
        lerrs = record_errors(label, "agent_label")
        if lerrs:
            raise ValidationFailed([f"{rel_dir} label: {m}" for m in lerrs])
        label_bytes = (canonical_json(label) + "\n").encode("utf-8")
        kept_seg = {s for b in built["blocks"] for p in b["speech"] for s in p["segment_ids"]}
        kept_ev = {e["event_id"] for b in built["blocks"] for e in b["audit"]["events"]}
        excluded = (excluded_records(pub, cfg, dataset, kept_seg, kept_ev) if cutoff is None
                    else [{"reason": "截止点样本不单列排除项：完整文档的 audit.json 已列出全部排除记录与原因", "count": 0}])
        audit = _audit(built, sample_id=sid, dataset=dataset, cfg=cfg, cutoff=cutoff, input_sha=input_sha,
                       excluded=excluded, open_questions=questions)
        aerrs = record_errors(audit, "agent_pair_audit")
        if aerrs:
            raise ValidationFailed([f"{rel_dir} audit: {m}" for m in aerrs])
        d = out_root / rel_dir
        write_bytes(d / "input.zh.txt", text_bytes)
        write_bytes(d / "label.json", label_bytes)
        write_json(d / "blocks.json", built["doc"])
        write_json(d / "audit.json", audit)
        return {
            "sample_id": sid, "dataset": dataset, "kind": kind,
            "input_path": str((d / "input.zh.txt").relative_to(out_root)).replace("\\", "/"),
            "label_path": str((d / "label.json").relative_to(out_root)).replace("\\", "/"),
            "blocks_path": str((d / "blocks.json").relative_to(out_root)).replace("\\", "/"),
            "audit_path": str((d / "audit.json").relative_to(out_root)).replace("\\", "/"),
            "cutoff_sequence": cutoff["sequence"] if cutoff else None,
            "cutoff_label": cutoff["label"] if cutoff else None,
            "cutoff_public_at": cutoff["public_at"] if cutoff else None,
            "input_sha256": input_sha, "label_sha256": sha256_bytes(label_bytes),
            "size": {"characters": len(built["text"]), "utf8_bytes": len(text_bytes),
                     "blocks": len(built["doc"]["blocks"]), "speech_lines": len(speech_lines(built["text"])),
                     "tokens": None, "tokenizer": None},
        }

    pairs.append(emit("full", build_document(pub, cfg, dataset), None, "full"))

    view_for_cutoff = [r for r in pub["events"] + pub["utterances"] if r.get("review_status") != "rejected"]
    skipped = []
    for spec in cfg.get("cutoffs", []):
        try:
            rec = resolve_cutoff([r for r in view_for_cutoff if "event_id" in r], [r for r in view_for_cutoff if "utterance_id" in r], spec["after"])
            built = build_document(pub, cfg, dataset, rec["sequence"])
        except ValueError as e:
            skipped.append({"label": spec["label"], "reason": str(e)})
            continue
        cutoff = {"sequence": rec["sequence"], "label": spec["label"], "public_at": rec["availability"]["public_at"]}
        sid = sample_id_v3(game["game_id"], cfg["run_id"], dataset, perspective, rec["sequence"], revision)
        pairs.append(emit("cutoff", built, cutoff, f"cutoffs/{sid}"))

    write_bytes(out_root / "instruction.zh.txt", INSTRUCTION_ZH.encode("utf-8"))
    pair_manifest = {
        "schema": "vbench.agent_pair_manifest/1",
        "run_id": cfg["run_id"],
        "generated_from": {"source_id": source["source_id"], "game_id": game["game_id"], "group_id": game["group_id"],
                           "split": game["split"], "roster_file": str(roster_path) if roster else None},
        "instruction_file": "instruction.zh.txt",
        "revision": revision or None,
        "pairs": pairs,
    }
    if revision:
        base_root = _pair_paths(cfg, dataset, root, "")
        pair_manifest["revision_of"] = _revision_of(out_root, base_root, pairs, list(revision_reason or []))
    if pair_manifest["generated_from"]["roster_file"] is None:
        del pair_manifest["generated_from"]["roster_file"]
    merrs = record_errors(pair_manifest, "agent_pair_manifest")
    if merrs:
        raise ValidationFailed(merrs)
    write_json(out_root / "manifest.json", pair_manifest)
    write_json(out_root / "size_report.json", _size_report(cfg, dataset, pairs, root))
    return {"out_dir": str(out_root), "pairs": pairs, "skipped": skipped, "nickname_mentions": mentions,
            "manifest": str(out_root / "manifest.json"), "instruction": str(out_root / "instruction.zh.txt")}


def _size_report(cfg: dict, dataset: str, pairs: list[dict], root: Path | None) -> dict:
    """What the model now reads, next to what the older exports would have cost.

    Bytes only. No offline tokenizer for the target model is available here, so
    `tokens` stays null everywhere: a character count is not a token count and is
    not reported as one, and none of this proves a context window fits.
    """
    run = run_paths(cfg["run_id"], root)
    old = {
        "archival_game_record_json": run.root / "timeline_v2" / dataset / "game_record.json",
        "readable_transcript_md": run.root / "timeline_v2" / dataset / "transcript.zh.md",
    }
    prev = {k: (p.stat().st_size if p.exists() else None) for k, p in old.items()}
    x_dir = run.root / "samples_v2" / dataset / "X"
    x_files = sorted(x_dir.glob("*.json")) if x_dir.exists() else []
    full = next((p for p in pairs if p["kind"] == "full"), None)
    return {
        "run_id": cfg["run_id"],
        "dataset": dataset,
        "tokenizer": None,
        "tokens_measured": False,
        "note": "没有可离线使用的目标模型 tokenizer，因此 token 数未测；字符数不能当作 token 数，文件大小也不能证明一定放得进上下文窗口。",
        "input_full": None if full is None else {"characters": full["size"]["characters"], "utf8_bytes": full["size"]["utf8_bytes"]},
        "input_cutoffs": [{"cutoff_label": p["cutoff_label"], "characters": p["size"]["characters"], "utf8_bytes": p["size"]["utf8_bytes"]}
                          for p in pairs if p["kind"] == "cutoff"],
        "previous_exports_bytes": dict(prev, x_v2_json_max=max((p.stat().st_size for p in x_files), default=None),
                                       x_v2_json_files=len(x_files)),
    }


def load_pair(manifest_path: Path, sample_id: str) -> tuple[str, dict]:
    """(input text, label) for one pair — what an evaluator reads. Kept together only here."""
    m = read_json(manifest_path)
    entry = next(p for p in m["pairs"] if p["sample_id"] == sample_id)
    base = Path(manifest_path).parent
    text = (base / entry["input_path"]).read_text(encoding="utf-8")
    if sha256_bytes(text.encode("utf-8")) != entry["input_sha256"]:
        raise ValidationFailed([f"{sample_id}: input file does not match the manifest hash"])
    return text, read_json(base / entry["label_path"])
