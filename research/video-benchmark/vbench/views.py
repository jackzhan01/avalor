"""Apply corrections, allocate sequences, and write draft/accepted views."""

from __future__ import annotations

from pathlib import Path

from .corrections import apply_corrections
from .ledger import allocate, attach, empty_ledger, load_ledger, save_ledger
from .paths import annotation_paths, run_paths
from .util import read_jsonl, write_json, write_jsonl


def build_views(cfg: dict, source_id: str, root: Path | None = None, persist_ledger: bool = True) -> dict:
    run = run_paths(cfg["run_id"], root)
    ann = annotation_paths(source_id, root)
    machine = {
        "utterance": read_jsonl(run.public / "utterances.jsonl"),
        "public_event": read_jsonl(run.public / "events.jsonl"),
    }
    policy = cfg.get("corrections", {})
    sources = []
    if policy.get("inherit_shared", True):
        sources.append(ann.corrections)
    if policy.get("run_scoped", True):
        sources.append(ann.run_corrections(cfg["run_id"]))
    corrections = []
    for path in sources:
        rows = read_jsonl(path)
        corrections += sorted(rows, key=lambda c: c["revision"])
    views, report = apply_corrections(machine, corrections, cfg["rules"], presorted=True)
    ledger_path = ann.ledger(cfg["run_id"])
    ledger = load_ledger(ledger_path) if persist_ledger else (load_ledger(ledger_path) if ledger_path.exists() else empty_ledger())
    before = ledger["next_sequence"]
    allocate(ledger, [("utterance", u) for u in views["utterance"]] + [("public_event", e) for e in views["public_event"]])
    if persist_ledger:
        save_ledger(ledger_path, ledger)
    utt = attach(ledger, "utterance", views["utterance"])
    ev = attach(ledger, "public_event", views["public_event"])
    for name, pred in (("all", lambda r: True), ("draft", lambda r: r["review_status"] != "rejected"), ("accepted", lambda r: r["review_status"] == "accepted")):
        write_jsonl(run.views / name / "utterances.jsonl", [u for u in utt if pred(u)])
        write_jsonl(run.views / name / "events.jsonl", [e for e in ev if pred(e)])
    status_counts: dict = {}
    for r in utt + ev:
        k = ("utterance" if "utterance_id" in r else "event", r["review_status"])
        status_counts[f"{k[0]}:{k[1]}"] = status_counts.get(f"{k[0]}:{k[1]}", 0) + 1
    ordering_counts: dict = {}
    for r in utt + ev:
        s = r["ordering"]["status"]
        ordering_counts[s] = ordering_counts.get(s, 0) + 1
    summary = {
        "corrections_total": len(corrections),
        "correction_files": [str(x) for x in sources if x.exists()],
        "applied": len(report["applied"]),
        "stale": report["stale"],
        "conflicts": report["conflicts"],
        "invalid_after_apply": report["invalid_after_apply"],
        "sequences_allocated_this_build": ledger["next_sequence"] - before,
        "ledger_persisted": persist_ledger,
        "status_counts": status_counts,
        "ordering_counts": ordering_counts,
    }
    write_json(run.views / "build_report.json", summary)
    return summary
