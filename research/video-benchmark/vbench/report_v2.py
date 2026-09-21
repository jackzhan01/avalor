"""Timeline-revision report: transcript fidelity, attribution, turn boundaries,
objective events, coverage and review burden. Semantic-label recall is not a
metric here.

Every rate carries numerator/denominator and says whether it is measured
before correction (machine) or after (reviewed), and against what.
"""

from __future__ import annotations

import re
from pathlib import Path

from .paths import annotation_paths, run_paths
from .report import _match_captions, _ratio
from .textnorm import levenshtein, normalize_for_compare
from .util import fmt_tc, read_json, read_jsonl, write_bytes, write_json


def _ws(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def caption_fidelity(ref: dict, utterances: list[dict], lo: float, hi: float) -> dict:
    refs = [r for r in ref["captions"] if lo <= r["time"] < hi]
    machine = [{"id": u["utterance_id"], "start": u["caption"]["display_start"], "end": u["caption"]["display_end"], "text": u["caption"]["text"], "seat": u["speaker"]["seat"]}
               for u in utterances if u.get("caption") and u.get("review_status") != "rejected"]
    m = _match_captions(refs, machine)
    matched = [(r, m[r["ref_id"]]) for r in refs if m[r["ref_id"]]]
    used: dict = {}
    for _, x in matched:
        used[x["id"]] = used.get(x["id"], 0) + 1
    exact = sum(_ws(x["text"]) == _ws(r["text"]) for r, x in matched)
    edits = sum(levenshtein(_ws(x["text"]), _ws(r["text"])) for r, x in matched)
    chars = sum(len(_ws(r["text"])) for r, _ in matched)
    edits_norm = sum(levenshtein(normalize_for_compare(x["text"]), normalize_for_compare(r["text"])) for r, x in matched)
    chars_norm = sum(len(normalize_for_compare(r["text"])) for r, _ in matched)
    seat_ok = sum(1 for r, x in matched if x["seat"] == r.get("seat"))
    return {
        "reference_captions": len(refs),
        "recall": _ratio(len(matched), len(refs)),
        "omitted": [{"ref_id": r["ref_id"], "time": r["time"], "text": r["text"]} for r in refs if not m[r["ref_id"]]],
        "exact_text_incl_punctuation": _ratio(exact, len(matched)),
        "cer_incl_punctuation": {"edits": edits, "reference_chars": chars, "rate": round(edits / chars, 4) if chars else None},
        "cer_ignoring_punctuation": {"edits": edits_norm, "reference_chars": chars_norm, "rate": round(edits_norm / chars_norm, 4) if chars_norm else None},
        "machine_captions_covering_multiple_refs": sum(1 for v in used.values() if v > 1),
        "seat_attribution": _ratio(seat_ok, len(matched)),
        "mismatches": [{"ref_id": r["ref_id"], "time": r["time"], "ref": r["text"], "machine": x["text"]} for r, x in matched if _ws(x["text"]) != _ws(r["text"])][:40],
    }


def build_report_v2(cfg: dict, source_id: str, root: Path | None = None) -> dict:
    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    stats = read_json(run.public / "extract_stats.json")
    rec_acc = read_json(run.root / "timeline_v2" / "accepted" / "game_record.json")
    rec_dra = read_json(run.root / "timeline_v2" / "draft" / "game_record.json")
    machine = read_jsonl(run.public / "utterances.jsonl")
    views = read_jsonl(run.views / "all" / "utterances.jsonl")
    events_machine = read_jsonl(run.public / "events.jsonl")
    events_view = read_jsonl(run.views / "all" / "events.jsonl")
    corrections = read_jsonl(ann.run_corrections(cfg["run_id"]))
    if cfg.get("corrections", {}).get("inherit_shared", True):
        corrections = read_jsonl(ann.corrections) + corrections
    boundaries = read_jsonl(ann.root / f"turn_boundaries.{cfg['run_id']}.jsonl")
    migration = ann.root / "migrations"
    mig = [read_json(p) for p in sorted(migration.glob(f"*__{cfg['run_id']}.json"))] if migration.exists() else []

    rep: dict = {"run_id": cfg["run_id"], "interval": cfg["interval"]}
    rep["processing"] = {k: stats[k] for k in ("interval", "scan", "decode", "counters", "cache", "timings_s", "asr", "external_usage")}

    ref_path = ann.reference
    if ref_path.exists():
        ref = read_json(ref_path)
        lo, hi = ref["interval"]["start"], ref["interval"]["end"]
        rep["caption_fidelity_vs_independent_reference"] = {
            "reference": {"interval": [lo, hi], "status": ref["status"], "method": ref["method"]},
            "machine_before_correction": caption_fidelity(ref, [dict(u, review_status="machine_candidate") for u in machine], lo, hi),
            "after_correction": caption_fidelity(ref, views, lo, hi),
            "caveat": "after-correction numbers use corrections derived from the same reference: they show the corrections landed, not independent quality",
        }

    # objective events: machine vs reviewed view (reviewed view is the provisional reference beyond the pilot)
    obj = ("team_selection", "vote_observation", "vote_outcome", "mission_outcome")
    view_acc = {e["event_id"]: e for e in events_view if e["type"] in obj and e["review_status"] == "accepted"}
    mach = {e["event_id"]: e for e in events_machine if e["type"] in obj}
    added = [e for e in view_acc.values() if e.get("origin") == "correction"]
    fields = ok = 0
    diffs = []
    for eid, e in view_acc.items():
        if eid not in mach:
            continue
        for k, v in e["payload"].items():
            fields += 1
            if mach[eid]["payload"].get(k) == v:
                ok += 1
            else:
                diffs.append({"event": e["stable_key"], "field": k, "machine": mach[eid]["payload"].get(k), "reviewed": v})
    rejected = [e["stable_key"] for e in events_view if e["type"] in obj and e["review_status"] == "rejected"]
    rep["objective_events"] = {
        "reference": "provisional self-review of board snapshots and surrounding captions (accepted view)",
        "reviewed_events": len(view_acc),
        "machine_events": len(mach),
        "found_by_machine": _ratio(sum(1 for e in view_acc if e in mach), len(view_acc)),
        "added_by_review": [e["stable_key"] for e in added],
        "machine_events_rejected": rejected,
        "field_accuracy_before_correction": _ratio(ok, fields),
        "field_differences": diffs,
        "anchored": _ratio(sum(1 for e in view_acc.values() if e["availability"]["status"] == "anchored"), len(view_acc)),
        "unreviewed_machine_events": [e["stable_key"] for e in events_view if e["type"] in obj and e["review_status"] not in ("accepted", "rejected")],
    }

    speech_acc = [it for it in rec_acc["timeline"] if it["kind"] == "speech"]
    seg_total = sum(len(it["segments"]) for it in speech_acc)
    boundaries_total = sum(1 for it in speech_acc if it["boundary_before"]["type"] in ("new_turn", "new_part"))
    bdec = {"break": sum(1 for b in boundaries if b["decision"] == "break"), "join": sum(1 for b in boundaries if b["decision"] == "join")}
    rep["turns"] = {
        "accepted_turns": len({it["turn_id"] for it in speech_acc}),
        "accepted_parts": len(speech_acc),
        "accepted_segments": seg_total,
        "rule_boundaries_in_accepted": boundaries_total,
        "segment_joins_in_accepted": seg_total - len(speech_acc),
        "reviewer_boundary_corrections": bdec,
        "boundary_error_rate_found_in_review": _ratio(bdec["break"] + bdec["join"], (seg_total - 1) if seg_total else 0),
        "boundary_reason_counts": _count([r for it in speech_acc for r in it["boundary_before"]["reasons"]]),
        "long_pause_parts": sum(1 for it in speech_acc if "long_pause" in it["flags"]),
    }
    seat_fix = sum(1 for c in corrections if c["op"] == "set" and c.get("path") == "speaker.seat")
    text_fix = sum(1 for c in corrections if c["op"] == "set" and c.get("path") == "caption.text")
    utt_acc = sum(1 for u in views if u.get("caption") and u["review_status"] == "accepted")
    rep["attribution_and_text_review"] = {
        "accepted_caption_segments": utt_acc,
        "seat_corrections": _ratio(seat_fix, utt_acc),
        "text_corrections": _ratio(text_fix, utt_acc),
        "reviewer_added_captions": sum(1 for c in corrections if c["op"] == "add" and c["target"]["kind"] == "utterance"),
        "rejected_segments": sum(1 for u in views if u["review_status"] == "rejected"),
    }
    rep["coverage"] = {
        "accepted": rec_acc["coverage"],
        "draft_counts": rec_dra["coverage"]["counts"],
        "unreviewed_draft_segments": [
            {"segment_id": s["segment_id"], "time": fmt_tc(s["start"]), "text": s["text"], "source": s["source"]}
            for it in rec_dra["timeline"] if it["kind"] == "speech" for s in it["segments"] if s["review_status"] != "accepted"
        ][:200],
    }
    rep["review_burden"] = {
        "corrections_by_op": _count([c["op"] for c in corrections]),
        "migration": [m["counts"] for m in mig],
        "turn_boundary_corrections": len(boundaries),
    }
    write_json(run.reports / "timeline_v2_report.json", rep)
    write_bytes(run.reports / "timeline_v2_report.md", _md(rep).encode("utf-8"))
    return rep


def _count(xs):
    out: dict = {}
    for x in xs:
        out[x] = out.get(x, 0) + 1
    return out


def _r(x: dict) -> str:
    return f"{x['numerator']}/{x['denominator']}" + (f" ({x['rate']:.1%})" if x.get("rate") is not None else "")


def _md(rep: dict) -> str:
    L = [f"# 时间线修订报告 `{rep['run_id']}`", ""]
    p = rep["processing"]
    L += [f"处理 {p['interval']['processed_s']} s；OCR 调用 {p['counters'].get('ocr_calls', 0)}、命中 {p['counters'].get('ocr_cache_hits', 0)}、空文本回退 {p['counters'].get('ocr_empty_line_fallbacks', 0)}；ASR `{p['asr']['mode']}`；耗时 {p['timings_s']}；付费调用 {p['external_usage']['paid_api_calls']}", ""]
    cf = rep.get("caption_fidelity_vs_independent_reference")
    if cf:
        for tag, zh in (("machine_before_correction", "机器（修正前）"), ("after_correction", "修正后")):
            c = cf[tag]
            L += [f"## 字幕保真度 {zh}（对照 {cf['reference']['interval']} 独立参考）",
                  f"- 召回 {_r(c['recall'])}；含标点完全一致 {_r(c['exact_text_incl_punctuation'])}；CER 含标点 {c['cer_incl_punctuation']['edits']}/{c['cer_incl_punctuation']['reference_chars']}，忽略标点 {c['cer_ignoring_punctuation']['edits']}/{c['cer_ignoring_punctuation']['reference_chars']}；座位 {_r(c['seat_attribution'])}；合并错误 {c['machine_captions_covering_multiple_refs']}", ""]
        L += [f"注意：{cf['caveat']}", ""]
    o = rep["objective_events"]
    L += ["## 客观事件", f"- 审阅后事件 {o['reviewed_events']}；机器找到 {_r(o['found_by_machine'])}；修正前字段准确 {_r(o['field_accuracy_before_correction'])}；已锚定 {_r(o['anchored'])}；审阅补录 {len(o['added_by_review'])}；拒绝机器事件 {len(o['machine_events_rejected'])}；未审阅机器事件 {len(o['unreviewed_machine_events'])}", ""]
    t = rep["turns"]
    L += ["## 发言轮次", f"- accepted：轮次 {t['accepted_turns']}、部分 {t['accepted_parts']}、字幕卡 {t['accepted_segments']}；审阅边界修正 break {t['reviewer_boundary_corrections']['break']} / join {t['reviewer_boundary_corrections']['join']}（相邻卡边界 {_r(t['boundary_error_rate_found_in_review'])}）；边界原因 {t['boundary_reason_counts']}", ""]
    a = rep["attribution_and_text_review"]
    L += ["## 转写与归属审阅", f"- 已接受字幕卡 {a['accepted_caption_segments']}；改座位 {_r(a['seat_corrections'])}；改文本 {_r(a['text_corrections'])}；补录 {a['reviewer_added_captions']}；拒绝 {a['rejected_segments']}", ""]
    c = rep["coverage"]["accepted"]
    L += ["## 覆盖", f"- 区间 {c['interval']}；已审阅 {c['reviewed_intervals']}；未审阅 {c['unreviewed_intervals']}；缺口 {len(c['gaps'])}；accepted 计数 {c['counts']}", f"- draft 计数 {rep['coverage']['draft_counts']}", ""]
    L += ["## 审阅负担", f"- 修正 {rep['review_burden']['corrections_by_op']}；迁移 {rep['review_burden']['migration']}；轮次边界修正 {rep['review_burden']['turn_boundary_corrections']}"]
    return "\n".join(L) + "\n"
