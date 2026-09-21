"""Explicit correction migration between extraction runs.

A correction names the content hash of the record the reviewer saw. A new run
(longer interval, new OCR policy) changes record hashes even when the reviewed
facts are identical, e.g. because the ASR words or provenance changed. This
module carries a correction over only when the fields the reviewer actually
judged are identical in the new record, writes the result to the *target run's*
correction file with evidence pointing back to the original, and reports every
correction it did not carry and why. Nothing is silently re-applied.
"""

from __future__ import annotations

from pathlib import Path

from .corrections import append_corrections, content_sha, make_correction
from .paths import annotation_paths, run_paths
from .timeline import OBJECTIVE_EVENT_TYPES
from .util import read_jsonl, write_json

TOL = 1e-3


def _utt_fields(u: dict) -> tuple:
    c = u.get("caption") or {}
    return (c.get("text"), round(c.get("display_start", -1), 3), round(c.get("display_end", -1), 3), u["speaker"]["seat"], u["eligibility"])


def _event_fields(e: dict) -> tuple:
    from .util import canonical_json

    return (e["type"], canonical_json(e["payload"]), canonical_json(e["interpretations"]), round(e["observation"]["video_start"], 3))


def migrate_corrections(old_cfg: dict, new_cfg: dict, source_id: str, reviewer: str, root: Path | None = None, dry_run: bool = False) -> dict:
    ann = annotation_paths(source_id, root)
    old_run, new_run = run_paths(old_cfg["run_id"], root), run_paths(new_cfg["run_id"], root)
    old_idx = {
        "utterance": {content_sha(u): u for u in read_jsonl(old_run.public / "utterances.jsonl")},
        "public_event": {content_sha(e): e for e in read_jsonl(old_run.public / "events.jsonl")},
    }
    new_utts = read_jsonl(new_run.public / "utterances.jsonl")
    new_idx = {
        "utterance": {u["utterance_id"]: u for u in new_utts},
        "public_event": {e["event_id"]: e for e in read_jsonl(new_run.public / "events.jsonl")},
    }
    lo, hi = new_cfg["interval"]["start"], new_cfg["interval"]["end"]
    src_rows = read_jsonl(ann.corrections) if old_cfg.get("corrections", {}).get("inherit_shared", True) else []
    src_rows += read_jsonl(ann.run_corrections(old_cfg["run_id"]))
    target_path = ann.run_corrections(new_cfg["run_id"])
    existing = read_jsonl(target_path)
    already = {r2["id"] for c in existing for r2 in c.get("evidence_refs", []) if r2.get("kind") == "correction"}

    report = {"from_run": old_cfg["run_id"], "to_run": new_cfg["run_id"], "migrated": [], "not_migrated": []}
    new_rows: list[dict] = []

    def skip(c, why):
        report["not_migrated"].append({"correction_id": c["correction_id"], "op": c["op"], "target": c["target"]["id"], "reason": why})

    for c in src_rows:
        if c["correction_id"] in already:
            continue
        kind = c["target"]["kind"]
        if kind == "public_event":
            etype = (c["value"] or {}).get("type") if c["op"] == "add" else (old_idx[kind].get(c["target"]["content_sha256"]) or {}).get("type")
            if etype is not None and etype not in OBJECTIVE_EVENT_TYPES:
                skip(c, "semantic speech label: out of scope since the timeline revision (kept only in the historical run)")
                continue
        if c["op"] == "add":
            v = c["value"]
            if kind == "utterance":
                cap = v["caption"]
                overlap = [u for u in new_utts if u.get("caption") and u["caption"]["display_start"] < cap["display_end"] and cap["display_start"] < u["caption"]["display_end"]]
                same = [u for u in overlap if u["caption"]["text"] == cap["text"]]
                if same:
                    skip(c, f"superseded by machine record {same[0]['utterance_id']} in the new run (v2 OCR/merge fix); review that record instead")
                    continue
                if not (lo <= cap["display_start"] < hi):
                    skip(c, "outside target interval")
                    continue
            new_rows.append(make_correction(existing + new_rows, kind=kind, target=None, target_id=c["target"]["id"], op="add", value=v, reviewer=reviewer,
                                            note=f"migrated add: {c['note']}", evidence_refs=[{"kind": "correction", "id": c["correction_id"], "note": f"from {old_cfg['run_id']}"}]))
            report["migrated"].append(c["correction_id"])
            continue
        old_rec = old_idx[kind].get(c["target"]["content_sha256"])
        if old_rec is None:
            skip(c, "original target not found in the source run (already stale there)")
            continue
        new_rec = new_idx[kind].get(c["target"]["id"])
        if new_rec is None:
            skip(c, "target id absent in the new run (segmentation or text changed): needs fresh review")
            continue
        fields = _utt_fields if kind == "utterance" else _event_fields
        if fields(old_rec) != fields(new_rec):
            skip(c, f"reviewed fields differ: old {fields(old_rec)} new {fields(new_rec)}")
            continue
        new_rows.append(make_correction(existing + new_rows, kind=kind, target=new_rec, op=c["op"], path=c["path"], value=c["value"], reviewer=reviewer,
                                        note=f"migrated: {c['note']}", supersedes=None,
                                        evidence_refs=(c.get("evidence_refs") or []) + [{"kind": "correction", "id": c["correction_id"], "note": f"from {old_cfg['run_id']}: reviewed fields identical"}]))
        report["migrated"].append(c["correction_id"])

    report["counts"] = {"source": len(src_rows), "migrated": len(report["migrated"]), "not_migrated": len(report["not_migrated"])}
    reasons: dict = {}
    for r in report["not_migrated"]:
        key = r["reason"].split(":")[0]
        reasons[key] = reasons.get(key, 0) + 1
    report["counts"]["not_migrated_by_reason"] = reasons
    if not dry_run and new_rows:
        append_corrections(target_path, new_rows)
    write_json(ann.root / "migrations" / f"{old_cfg['run_id']}__{new_cfg['run_id']}.json", report)
    return report
