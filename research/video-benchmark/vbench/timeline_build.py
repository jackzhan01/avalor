"""Write the canonical public game record and its readable transcript for a run.

Public side only: reads corrected views, machine utterances, coverage gaps,
review scope and turn-boundary corrections. Never reads private files.
"""

from __future__ import annotations

from pathlib import Path

from .paths import annotation_paths, run_paths
from .render import render_markdown, speech_paragraphs
from .timeline import build_game_record, load_boundary_decisions, load_coverage
from .util import read_json, read_jsonl, sha256_json, short_id, write_bytes, write_json
from .validate import ValidationFailed, record_errors


def timeline_paths(cfg: dict, source_id: str, root: Path | None = None) -> dict:
    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    t = cfg.get("timeline", {})
    return {
        "out": run.root / "timeline_v2",
        "coverage": Path(t["coverage_file"]) if t.get("coverage_file") else ann.root / "coverage.json",
        "review_scope": ann.root / f"review_scope.{cfg['run_id']}.json",
        "boundaries": ann.root / f"turn_boundaries.{cfg['run_id']}.jsonl",
        "views_all": run.views / "all",
        "machine_utterances": run.public / "utterances.jsonl",
    }


def check_render_consistency(record: dict, markdown: str) -> list[str]:
    """The transcript must carry exactly the record's speech, in the same order."""
    want = [it["text"] for it in record["timeline"] if it["kind"] == "speech"]
    got = speech_paragraphs(markdown)
    errs = []
    if want != got:
        errs.append(f"speech paragraphs differ: record {len(want)} vs transcript {len(got)}")
    n_events = sum(1 for it in record["timeline"] if it["kind"] == "event")
    n_blocks = sum(1 for line in markdown.splitlines() if line.startswith("> **【") and not line.startswith("> **【剪辑缺口】**"))
    if n_events != n_blocks:
        errs.append(f"event blocks differ: record {n_events} vs transcript {n_blocks}")
    return errs


def segment_accounting(record: dict, utterances: list[dict], dataset: str, live_end: float | None = None) -> list[str]:
    """Every eligible accepted segment appears exactly once; nothing else appears."""
    from .timeline import select_atoms

    atoms, _ = select_atoms(utterances, [], dataset, live_end)
    expected = [a["rec"]["utterance_id"] for a in atoms if a["kind"] == "segment"]
    seen = [s["segment_id"] for it in record["timeline"] if it["kind"] == "speech" for s in it["segments"]]
    errs = []
    if sorted(expected) != sorted(seen):
        missing = set(expected) - set(seen)
        extra = set(seen) - set(expected)
        errs.append(f"segment accounting: missing {len(missing)}, unexpected {len(extra)}")
    if len(seen) != len(set(seen)):
        errs.append("segment accounting: a segment appears more than once")
    for it in record["timeline"]:
        if it["kind"] == "speech" and it["text"] != " ".join(s["text"] for s in it["segments"]):
            errs.append(f"{it['item_id']}: joined text is not traceable to its segments")
    return errs


def build_timeline(cfg: dict, source_id: str, datasets=("accepted", "draft"), root: Path | None = None) -> dict:
    p = timeline_paths(cfg, source_id, root)
    utterances = read_jsonl(p["views_all"] / "utterances.jsonl")
    events = read_jsonl(p["views_all"] / "events.jsonl")
    machine = read_jsonl(p["machine_utterances"])
    coverage = load_coverage(p["coverage"])
    if coverage is not None:
        errs = record_errors(coverage, "coverage")
        if errs:
            raise ValidationFailed(errs)
    scope = read_json(p["review_scope"]) if p["review_scope"].exists() else None
    decisions = load_boundary_decisions(p["boundaries"])
    audit = {
        "views": str(p["views_all"]),
        "coverage_file": str(p["coverage"]) if coverage else None,
        "review_scope_file": str(p["review_scope"]) if scope else None,
        "turn_boundary_file": str(p["boundaries"]) if decisions else None,
        "views_sha256": sha256_json([sha256_json(utterances), sha256_json(events)]),
    }
    summary = {}
    for ds in datasets:
        record, arep = build_game_record(
            cfg=cfg, source_id=source_id, dataset=ds, utterances=utterances, events=events, machine_utterances=machine,
            coverage=coverage, review_scope=scope, boundary_decisions=decisions, audit=audit,
        )
        errs = record_errors(record, "game_record")
        md = render_markdown(record)
        errs += check_render_consistency(record, md)
        live = (coverage or {}).get("live_game_interval")
        errs += segment_accounting(record, utterances, ds, live[1] if live else None)
        out = p["out"] / ds
        write_json(out / "game_record.json", record)
        write_bytes(out / "transcript.zh.md", md.encode("utf-8"))
        summary[ds] = {
            "game_record": str(out / "game_record.json"),
            "transcript": str(out / "transcript.zh.md"),
            "items": len(record["timeline"]),
            "counts": record["coverage"]["counts"],
            "reviewed_intervals": record["coverage"]["reviewed_intervals"],
            "unreviewed_intervals": record["coverage"]["unreviewed_intervals"],
            "errors": errs,
        }
    write_json(p["out"] / "build_summary.json", summary)
    return summary


def make_boundary_correction(existing: list[dict], *, before: dict, after: dict, decision: str, reviewer: str, note: str, supersedes: str | None = None) -> dict:
    from .timeline import segment_fingerprint

    revision = max((c["revision"] for c in existing), default=0) + 1
    return {
        "schema": "vbench.turn_boundary_correction/1",
        "correction_id": short_id("tbc", revision, before["utterance_id"], after["utterance_id"], decision),
        "revision": revision,
        "reviewer": reviewer,
        "before_segment": {"id": before["utterance_id"], "content_sha256": segment_fingerprint(before)},
        "after_segment": {"id": after["utterance_id"], "content_sha256": segment_fingerprint(after)},
        "decision": decision,
        "note": note,
        "supersedes": supersedes,
    }
