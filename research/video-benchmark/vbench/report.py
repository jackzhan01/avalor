"""Pilot report: processing stats and quality measured against a separately recorded reference.

Quality is never measured as OCR/ASR agreement. Every rate is reported with
its numerator and denominator, and whether it is before or after corrections.
"""

from __future__ import annotations

from pathlib import Path

from .paths import annotation_paths, run_paths
from .textnorm import levenshtein, normalize_for_compare
from .util import read_json, read_jsonl, write_bytes, write_json


def _ratio(n: int, d: int) -> dict:
    return {"numerator": n, "denominator": d, "rate": round(n / d, 4) if d else None}


def _match_captions(ref_caps: list[dict], machine: list[dict], tol: float = 0.12) -> dict[str, dict | None]:
    out = {}
    for r in ref_caps:
        t = r["time"]
        hit = [m for m in machine if m["start"] - tol <= t < m["end"] + tol]
        # Prefer the caption that actually contains t over a neighbour within tolerance.
        inside = sorted((m for m in hit if m["start"] <= t < m["end"]), key=lambda m: m["end"] - m["start"])
        # The tightest containing interval wins: a merged machine caption and a
        # reviewer-added split caption can both contain the same moment.
        out[r["ref_id"]] = (inside or hit or [None])[0]
    return out


def caption_metrics(ref: dict, machine_caps: list[dict]) -> dict:
    refs = [r for r in ref["captions"] if ref["interval"]["start"] <= r["time"] < ref["interval"]["end"]]
    matches = _match_captions(refs, machine_caps)
    matched = [(r, matches[r["ref_id"]]) for r in refs if matches[r["ref_id"]] is not None]
    edits = sum(levenshtein(normalize_for_compare(m["text"]), normalize_for_compare(r["text"])) for r, m in matched)
    ref_chars = sum(len(normalize_for_compare(r["text"])) for r, _ in matched)
    exact = sum(normalize_for_compare(m["text"]) == normalize_for_compare(r["text"]) for r, m in matched)
    used: dict[str, int] = {}
    for _, m in matched:
        used[m["id"]] = used.get(m["id"], 0) + 1
    merged = sum(1 for v in used.values() if v > 1)
    seat_ok = seat_wrong = seat_unknown = seat_ref_null = 0
    wrong_examples = []
    for r, m in matched:
        if r.get("seat") is None:
            seat_ref_null += 1
        elif m["seat"] is None:
            seat_unknown += 1
        elif m["seat"] == r["seat"]:
            seat_ok += 1
        else:
            seat_wrong += 1
            wrong_examples.append({"ref_id": r["ref_id"], "time": r["time"], "ref_seat": r["seat"], "machine_seat": m["seat"]})
    spurious = [m for m in machine_caps if m["id"] not in used and ref["interval"]["start"] <= m["start"] < ref["interval"]["end"]]
    errors = [
        {"ref_id": r["ref_id"], "time": r["time"], "ref": r["text"], "machine": m["text"], "edits": levenshtein(normalize_for_compare(m["text"]), normalize_for_compare(r["text"]))}
        for r, m in matched if normalize_for_compare(m["text"]) != normalize_for_compare(r["text"])
    ]
    seat_den = seat_ok + seat_wrong + seat_unknown
    return {
        "reference_captions": len(refs),
        "recall": _ratio(len(matched), len(refs)),
        "omitted": [{"ref_id": r["ref_id"], "time": r["time"], "text": r["text"]} for r in refs if matches[r["ref_id"]] is None],
        "cer": {"edits": edits, "reference_chars": ref_chars, "rate": round(edits / ref_chars, 4) if ref_chars else None},
        "exact_match": _ratio(exact, len(matched)),
        "machine_captions_covering_multiple_refs": merged,
        "spurious_machine_captions": {"count": len(spurious), "examples": [{"start": m["start"], "text": m["text"]} for m in spurious[:10]]},
        "seat_attribution": {
            "correct": _ratio(seat_ok, seat_den), "wrong": _ratio(seat_wrong, seat_den), "machine_unknown": _ratio(seat_unknown, seat_den),
            "reference_has_no_seat": seat_ref_null, "wrong_examples": wrong_examples[:20],
        },
        "text_errors": errors,
    }


def _event_match(ref_ev: dict, events: list[dict]) -> dict | None:
    p = ref_ev["payload"]
    cands = [e for e in events if e["type"] == ref_ev["type"]]
    if ref_ev["type"] in ("team_selection", "vote_observation", "vote_outcome"):
        cands = [e for e in cands if e["payload"].get("mission") == p.get("mission")]
        by_idx = [e for e in cands if e["payload"].get("proposal_index") == p.get("proposal_index")]
        if by_idx:
            return by_idx[0]
        # A missing proposal index is itself a field error; fall back to the leader.
        by_leader = [e for e in cands if e["payload"].get("leader_seat") == p.get("leader_seat") and "leader_seat" in p]
        return by_leader[0] if by_leader else None
    if ref_ev["type"] == "mission_outcome":
        cands = [e for e in cands if e["payload"].get("mission") == p.get("mission")]
        return cands[0] if cands else None
    want = normalize_for_compare(ref_ev.get("utterance_text"))
    cands = [e for e in cands if want and want in normalize_for_compare(e.get("_utt_text"))]
    if "target_seat" in p:
        cands = [e for e in cands if e["payload"].get("target_seat") == p["target_seat"]] or cands
    return cands[0] if cands else None


def _field_equal(ref_value, machine_value) -> bool:
    if isinstance(ref_value, dict) and isinstance(machine_value, dict):
        # Reference holders carry kind+seat only; basis text is machine provenance.
        return all(machine_value.get(k) == v for k, v in ref_value.items())
    return ref_value == machine_value


def event_metrics(ref: dict, events: list[dict]) -> dict:
    field_ok = field_total = found = 0
    rows = []
    for rev in ref["events"]:
        m = _event_match(rev, events)
        if m is None:
            rows.append({"ref_id": rev["ref_id"], "type": rev["type"], "found": False})
            for _ in rev["payload"]:
                field_total += 1
            continue
        found += 1
        diffs = {}
        for k, v in rev["payload"].items():
            field_total += 1
            if _field_equal(v, m["payload"].get(k)):
                field_ok += 1
            else:
                diffs[k] = {"reference": v, "machine": m["payload"].get(k)}
        anchor = None
        if "public_at" in rev:
            anchor = {"reference": rev["public_at"], "machine": m["availability"]["public_at"], "status": m["availability"]["status"]}
        rows.append({"ref_id": rev["ref_id"], "type": rev["type"], "found": True, "field_diffs": diffs, "availability": anchor})
    groups = {"board": ("team_selection", "vote_observation", "vote_outcome", "mission_outcome"), "speech": ("role_claim", "stance", "intended_team", "lady_announcement")}
    by_group = {}
    for g, types in groups.items():
        g_rows = [(rev, row) for rev, row in zip(ref["events"], rows) if rev["type"] in types]
        g_fields = sum(len(rev["payload"]) for rev, _ in g_rows)
        g_bad = sum(len(rev["payload"]) if not row["found"] else len(row["field_diffs"]) for rev, row in g_rows)
        by_group[g] = {"found": _ratio(sum(row["found"] for _, row in g_rows), len(g_rows)), "field_accuracy": _ratio(g_fields - g_bad, g_fields)}
    return {
        "reference_events": len(ref["events"]),
        "found": _ratio(found, len(ref["events"])),
        "field_accuracy": _ratio(field_ok, field_total),
        "by_group": by_group,
        "rows": rows,
    }


def speech_candidate_review(events: list[dict], corrections: list[dict]) -> dict:
    """How reviewers judged machine statement candidates (precision proxy, not recall)."""
    speech = {e["event_id"] for e in events if e["source"] == "speech"}
    ops: dict[str, set] = {}
    for c in corrections:
        if c["target"]["id"] in speech:
            ops.setdefault(c["target"]["id"], set()).add(c["op"])
    correct = sum(1 for v in ops.values() if v == {"accept"})
    fixed = sum(1 for v in ops.values() if "set" in v and "reject" not in v)
    rejected = sum(1 for v in ops.values() if "reject" in v)
    return {
        "machine_candidates": len(speech), "reviewed": len(ops),
        "accepted_unchanged": _ratio(correct, len(speech)), "accepted_after_fix": _ratio(fixed, len(speech)), "rejected": _ratio(rejected, len(speech)),
    }


def _machine_caption_view(utterances: list[dict]) -> list[dict]:
    out = []
    for u in utterances:
        c = u.get("caption")
        if c is None:
            continue
        out.append({"id": u["utterance_id"], "start": c["display_start"], "end": c["display_end"], "text": c["text"], "seat": u["speaker"]["seat"]})
    return out


def build_report(cfg: dict, source_id: str, root: Path | None = None) -> dict:
    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    stats = read_json(run.public / "extract_stats.json")
    build = read_json(run.views / "build_report.json") if (run.views / "build_report.json").exists() else None
    queue = read_jsonl(run.review / "queue.jsonl")
    corrections = read_jsonl(ann.corrections)
    report: dict = {
        "run_id": cfg["run_id"],
        "interval": cfg["interval"],
        "processing": {
            "processed_duration_s": stats["interval"]["processed_s"],
            "frames_decoded": stats["decode"]["frames_decoded"],
            "corrupt_packets": stats["decode"]["corrupt_packets"],
            "coarse_samples": stats["scan"]["coarse_samples"],
            "frames_converted": stats["scan"]["frames_converted"],
            "refine_windows": stats["scan"]["refine_windows"],
            "ocr_calls": stats["counters"].get("ocr_calls", 0),
            "ocr_cache_hits": stats["counters"].get("ocr_cache_hits", 0),
            "asr_mode": stats["asr"]["mode"],
            "asr_calls": stats["counters"].get("asr_calls", 0),
            "asr_cache_hits": stats["counters"].get("asr_cache_hits", 0),
            "elapsed_s": stats["timings_s"],
            "external_usage": stats["external_usage"],
            "sampling": stats["sampling"],
        },
        "outputs": stats["outputs"],
        "review": {
            "queue_items": len(queue),
            "reason_counts": _count_reasons(queue),
            "corrections": len(corrections),
            "corrections_by_op": _count([c["op"] for c in corrections]),
        },
        "build": build,
    }
    if ann.reference.exists():
        ref = read_json(ann.reference)
        machine_utts = read_jsonl(run.public / "utterances.jsonl")
        after_utts = read_jsonl(run.views / "all" / "utterances.jsonl")
        machine_events = read_jsonl(run.public / "events.jsonl")
        after_events = read_jsonl(run.views / "all" / "events.jsonl")
        for evs, utts in ((machine_events, machine_utts), (after_events, after_utts)):
            texts = {u["utterance_id"]: (u["caption"] or {}).get("text") for u in utts}
            for e in evs:
                e["_utt_text"] = texts.get(e["payload"].get("utterance_id"))
        report["quality"] = {
            "reference": {"reviewer": ref["reviewer"], "status": ref["status"], "method": ref["method"], "interval": ref["interval"]},
            "captions_before_correction": caption_metrics(ref, _machine_caption_view(machine_utts)),
            "captions_after_correction": caption_metrics(ref, _machine_caption_view([u for u in after_utts if u["review_status"] != "rejected"])),
            "events_before_correction": event_metrics(ref, machine_events),
            "events_after_correction": event_metrics(ref, [e for e in after_events if e["review_status"] != "rejected"]),
            "speech_candidate_review": speech_candidate_review(machine_events, corrections),
            "after_correction_caveat": "after-correction numbers are computed against the same reference the corrections were derived from; they show the corrections landed, not independent quality",
            "dense_checks": ref.get("dense_checks", []),
            "notes": ref.get("notes", []),
            "verbatim_speech_accuracy": "not reported: no audio-verified reference exists",
        }
    write_json(run.reports / "pilot_report.json", report)
    write_bytes(run.reports / "pilot_report.md", _markdown(report).encode("utf-8"))
    return report


def _count(xs):
    out: dict = {}
    for x in xs:
        out[x] = out.get(x, 0) + 1
    return out


def _count_reasons(queue):
    return _count([r for it in queue for r in it["reasons"]])


def _fmt_ratio(r: dict) -> str:
    return f"{r['numerator']}/{r['denominator']}" + (f" ({r['rate']:.1%})" if r["rate"] is not None else "")


def _markdown(rep: dict) -> str:
    p = rep["processing"]
    lines = [
        f"# 试点报告 `{rep['run_id']}`",
        "",
        f"区间 {rep['interval']['start']}–{rep['interval']['end']} s；处理 {p['processed_duration_s']} s，解码 {p['frames_decoded']} 帧，粗采样 {p['coarse_samples']} 次，转换 {p['frames_converted']} 帧。",
        f"OCR 调用 {p['ocr_calls']}，缓存命中 {p['ocr_cache_hits']}；ASR 模式 `{p['asr_mode']}`（调用 {p['asr_calls']}，命中 {p['asr_cache_hits']}）；外部付费调用 {p['external_usage']['paid_api_calls']}。",
        f"耗时：{p['elapsed_s']}",
        "",
        f"审阅队列 {rep['review']['queue_items']} 条；修正 {rep['review']['corrections']} 条 {rep['review']['corrections_by_op']}。",
        "",
    ]
    q = rep.get("quality")
    if q:
        for tag in ("before", "after"):
            c = q[f"captions_{tag}_correction"]
            e = q[f"events_{tag}_correction"]
            lines += [
                f"## 字幕与事件（{'修正前' if tag == 'before' else '修正后'}）",
                f"- 参考字幕召回：{_fmt_ratio(c['recall'])}；遗漏 {len(c['omitted'])}",
                f"- 字符错误率：{c['cer']['edits']}/{c['cer']['reference_chars']} = {c['cer']['rate']}",
                f"- 完全一致：{_fmt_ratio(c['exact_match'])}",
                f"- 座位归属正确 {_fmt_ratio(c['seat_attribution']['correct'])}，错误 {_fmt_ratio(c['seat_attribution']['wrong'])}，机器未知 {_fmt_ratio(c['seat_attribution']['machine_unknown'])}",
                f"- 多余机器字幕：{c['spurious_machine_captions']['count']}",
                f"- 事件找到：{_fmt_ratio(e['found'])}；字段准确：{_fmt_ratio(e['field_accuracy'])}",
                f"  - 板面事件：找到 {_fmt_ratio(e['by_group']['board']['found'])}，字段 {_fmt_ratio(e['by_group']['board']['field_accuracy'])}",
                f"  - 言语事件：找到 {_fmt_ratio(e['by_group']['speech']['found'])}，字段 {_fmt_ratio(e['by_group']['speech']['field_accuracy'])}",
                "",
            ]
        sc = q["speech_candidate_review"]
        lines += [
            f"言语事件候选审阅：原样接受 {_fmt_ratio(sc['accepted_unchanged'])}，修正后接受 {_fmt_ratio(sc['accepted_after_fix'])}，拒绝 {_fmt_ratio(sc['rejected'])}",
            "",
            f"注意：{q['after_correction_caveat']}",
            "",
        ]
        lines.append(f"逐字语音准确率：{q['verbatim_speech_accuracy']}")
    return "\n".join(lines) + "\n"
