"""Review queue export: public crops, candidate text, discrepancy reasons, correction templates.

Only public-region crops appear here. Full frames and roster crops live under
`private/` and are never linked from review artifacts.
"""

from __future__ import annotations

from pathlib import Path

from .corrections import content_sha
from .paths import annotation_paths, run_paths
from .util import fmt_tc, read_jsonl, sha256_bytes, short_id, write_bytes, write_jsonl


def _clean_pick(record_id: str, rate: float) -> bool:
    # Deterministic "random" sample so reruns review the same clean records.
    return int(sha256_bytes(record_id.encode())[:8], 16) / 0xFFFFFFFF < rate


def utterance_reasons(u: dict) -> list[str]:
    reasons = []
    flags = set(u["flags"])
    if "guard_mismatch" in flags:
        reasons.append("guard_mismatch")
    if u["speaker"]["attribution"] == "label_transition":
        reasons.append("label_transition")
    if u["speaker"]["attribution"] == "no_label":
        reasons.append("no_label")
    if u["alignment"]["status"] == "disagree":
        reasons.append("ocr_asr_disagree")
    if "numeral_mismatch" in u["alignment"]["reasons"]:
        reasons.append("numeral_mismatch")
    if "negation_mismatch" in u["alignment"]["reasons"]:
        reasons.append("negation_mismatch")
    if u["alignment"]["status"] == "asr_only":
        reasons.append("asr_only")
    if "low_score" in flags:
        reasons.append("low_score")
    if "short" in flags:
        reasons.append("short")
    return reasons


def event_reasons(e: dict) -> list[str]:
    reasons = []
    flags = set(e["flags"])
    if e["availability"]["status"] == "unanchored":
        reasons.append("unanchored")
    for f, r in (("board_conflict", "board_conflict"), ("tally_vector_conflict", "tally_vector_conflict"), ("unresolved_quote", "unresolved_quote"), ("no_first_person_marker", "no_first_person_marker")):
        if f in flags:
            reasons.append(r)
    if e["source"] == "speech":
        reasons.append("speech_event_candidate")
    return reasons


def build_review_queue(cfg: dict, source_id: str, root: Path | None = None) -> dict:
    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    rate = cfg["captions"].get("clean_sample_rate", 0.1)
    utts = read_jsonl(run.public / "utterances.jsonl")
    events = read_jsonl(run.public / "events.jsonl")
    utt_by_id = {u["utterance_id"]: u for u in utts}
    items = []
    for u in utts:
        reasons = utterance_reasons(u)
        if not reasons and _clean_pick(u["utterance_id"], rate):
            reasons = ["clean_sample"]
        if not reasons:
            continue
        cap = u["caption"]
        start = cap["display_start"] if cap else u["asr"]["audio_start"]
        end = cap["display_end"] if cap else u["asr"]["audio_end"]
        details = []
        if u["asr"]["text"] is not None:
            details.append(f"ASR: {u['asr']['text']}")
        if cap and cap["alternatives"]:
            details.append("OCR alternatives: " + " | ".join(cap["alternatives"]))
        if u["speaker"]["labels_seen"]:
            details.append("labels: " + ", ".join(f"{l['label_text']}({l['overlap_s']}s)" for l in u["speaker"]["labels_seen"]))
        items.append({
            "schema": "vbench.review_item/1",
            "review_id": short_id("rev", "utterance", u["utterance_id"]),
            "target": {"kind": "utterance", "id": u["utterance_id"], "content_sha256": content_sha(u)},
            "reasons": reasons,
            "video_start": start,
            "video_end": end,
            "timecode": f"{fmt_tc(start)}–{fmt_tc(end)}",
            "crops": [cap["crop"]] if cap and cap.get("crop") else [],
            "candidate": {
                "caption_text": cap["text"] if cap else None,
                "seat": u["speaker"]["seat"],
                "label_text": u["speaker"]["label_text"],
                "alignment": u["alignment"],
                "eligibility": u["eligibility"],
            },
            "details": details,
        })
    for e in events:
        reasons = event_reasons(e)
        if not reasons:
            continue
        crops = []
        uid = e["payload"].get("utterance_id")
        if uid and uid in utt_by_id and utt_by_id[uid]["caption"] and utt_by_id[uid]["caption"].get("crop"):
            crops.append(utt_by_id[uid]["caption"]["crop"])
        details = [f"interpretation: {it['payload']} ({it['note']})" for it in e["interpretations"]]
        if uid and uid in utt_by_id and utt_by_id[uid]["caption"]:
            details.append(f"utterance: {utt_by_id[uid]['caption']['text']}")
        items.append({
            "schema": "vbench.review_item/1",
            "review_id": short_id("rev", "public_event", e["event_id"]),
            "target": {"kind": "public_event", "id": e["event_id"], "content_sha256": content_sha(e)},
            "reasons": reasons,
            "video_start": e["observation"]["video_start"],
            "video_end": e["observation"]["video_end"],
            "timecode": f"{fmt_tc(e['observation']['video_start'])}–{fmt_tc(e['observation']['video_end'])}",
            "crops": crops,
            "candidate": {"type": e["type"], "payload": e["payload"], "source": e["source"], "availability": e["availability"]},
            "details": details,
        })

    # Corrections that no longer land (re-extraction changed their target).
    from .corrections import apply_corrections

    policy = cfg.get("corrections", {})
    rows = (read_jsonl(ann.corrections) if policy.get("inherit_shared", True) else []) + (read_jsonl(ann.run_corrections(cfg["run_id"])) if policy.get("run_scoped", True) else [])
    _, rep = apply_corrections({"utterance": utts, "public_event": events}, rows, cfg["rules"], presorted=True)
    for s in rep["stale"] + rep["conflicts"]:
        items.append({
            "schema": "vbench.review_item/1",
            "review_id": short_id("rev", "correction", s["correction_id"]),
            "target": {"kind": "correction", "id": s["correction_id"], "content_sha256": None},
            "reasons": ["stale_correction" if s["reason"].startswith("stale") else "correction_conflict"],
            "video_start": None, "video_end": None, "timecode": "--",
            "crops": [], "candidate": {}, "details": [s["reason"]],
        })

    items.sort(key=lambda it: (it["video_start"] is None, it["video_start"] or 0, it["review_id"]))
    write_jsonl(run.review / "queue.jsonl", items)
    _write_markdown(run.review / "queue.md", items, run.root)
    counts: dict[str, int] = {}
    for it in items:
        for r in it["reasons"]:
            counts[r] = counts.get(r, 0) + 1
    return {
        "items": len(items),
        "reason_counts": counts,
        "utterances_total": len(utts),
        "events_total": len(events),
        "stale_corrections": len(rep["stale"]),
        "correction_conflicts": len(rep["conflicts"]),
    }


def _write_markdown(path: Path, items: list[dict], run_root: Path) -> None:
    lines = [
        "# 审阅队列",
        "",
        "只含公开区域裁剪。每条下面的 `target` 与 `content_sha256` 原样填进修正记录（见 README「审阅与修正」）。",
        "",
    ]
    for it in items:
        lines.append(f"## {it['timecode']} · {', '.join(it['reasons'])}")
        c = it["candidate"]
        if "caption_text" in c:
            lines.append(f"- 字幕：`{c['caption_text']}`  座位：`{c['seat']}`  标签：`{c['label_text']}`  对齐：`{c['alignment']['status']}` cer=`{c['alignment']['cer']}`")
        elif "type" in c:
            lines.append(f"- 事件：`{c['type']}` `{c['payload']}`  来源：`{c['source']}`  可得：`{c['availability']['status']}`")
        for d in it["details"]:
            lines.append(f"- {d}")
        for crop in it["crops"]:
            lines.append(f"- ![crop](../{crop})")
        lines.append(f"- target: `{it['target']['kind']}` `{it['target']['id']}` sha `{it['target']['content_sha256']}`")
        lines.append("")
    write_bytes(path, "\n".join(lines).encode("utf-8"))
