"""Evaluator-side orchestration of X/Y export. X and Y are built by separate modules
and written to separate directories; only this module sees both."""

from __future__ import annotations

from pathlib import Path

from .paths import annotation_paths, run_paths
from .private_labels import build_y, load_roles
from .samples import build_x, check_perspective, resolve_cutoff, sample_id_for, x_bytes
from .source import load_manifest, save_manifest
from .util import canonical_json, read_jsonl, sha256_bytes, write_bytes
from .validate import ValidationFailed, record_errors


def export_samples(cfg: dict, source: dict, dataset: str, root: Path | None = None, perspective: str = "public_observer", roles_path: Path | None = None) -> list[dict]:
    check_perspective(perspective)
    run = run_paths(cfg["run_id"], root)
    view = run.views / dataset
    utts = read_jsonl(view / "utterances.jsonl")
    events = read_jsonl(view / "events.jsonl")
    ann = annotation_paths(source["source_id"], root)
    roles_path = roles_path or ann.private_roles
    roles = load_roles(roles_path) if roles_path.exists() else None

    manifest = load_manifest(root)
    game = next(g for g in manifest["games"] if g["game_id"] == source["game_id"])
    forbidden = [
        source["source_id"], source["video_sha256"], cfg["source"].get("bvid"), cfg["source"].get("url"),
        cfg["source"].get("aid"), cfg["source"].get("cid"), game["game_id"],
    ] + [str(v) for v in (source.get("record", {}).get("title"), source.get("record", {}).get("uploader")) if v]

    out = []
    # v1 export only replaces v1 entries; timeline-revision (x2) entries are kept.
    manifest["samples"] = [s for s in manifest["samples"] if not (s["game_id"] == game["game_id"] and s["dataset"] == dataset and s.get("format", "x1") == "x1")]
    for spec in cfg["cutoffs"]:
        try:
            rec = resolve_cutoff(events, utts, spec["after"])
        except ValueError as e:
            out.append({"label": spec["label"], "status": "skipped", "reason": str(e)})
            continue
        seq = rec["sequence"]
        sid = sample_id_for(game["game_id"], dataset, perspective, seq)
        x = build_x(utterances=utts, events=events, cutoff_sequence=seq, rules=cfg["rules"], sample_id=sid, dataset=dataset, perspective=perspective)
        errs = record_errors(x, "sample_x", forbidden_strings=forbidden)
        if errs:
            raise ValidationFailed([f"X {spec['label']}: {m}" for m in errs])
        y = build_y(roles, sid, dataset)
        errs = record_errors(y, "sample_y")
        if errs:
            raise ValidationFailed([f"Y {spec['label']}: {m}" for m in errs])
        xb = x_bytes(x)
        yb = (canonical_json(y) + "\n").encode("utf-8")
        prefix = "draft-" if dataset == "draft" else ""
        write_bytes(run.samples / dataset / "X" / f"{prefix}{sid}.json", xb)
        write_bytes(run.samples / dataset / "Y" / f"{prefix}{sid}.json", yb)
        entry = {
            "sample_id": sid, "game_id": game["game_id"], "group_id": game["group_id"], "split": game["split"],
            "dataset": dataset, "cutoff_sequence": seq, "cutoff_label": spec["label"],
            "cutoff_public_at": rec["availability"]["public_at"], "perspective": perspective,
            "x_sha256": sha256_bytes(xb), "y_sha256": sha256_bytes(yb), "history_items": len(x["history"]),
        }
        manifest["samples"].append(entry)
        out.append(dict(entry, label=spec["label"], status="written", scoring_mode=y["scoring_mode"]))
    save_manifest(manifest, root)
    return out


# ── timeline revision: X v2 / Y v2 ─────────────────────────────────────────


def export_samples_v2(cfg: dict, source: dict, dataset: str, root: Path | None = None, perspective: str = "public_observer", roster_path: Path | None = None) -> list[dict]:
    from .private_labels import build_y_v2, load_roster_v2
    from .samples import build_x_v2, sample_id_v2
    from .timeline_build import timeline_paths
    from .timeline import load_boundary_decisions, load_coverage

    check_perspective(perspective)
    run = run_paths(cfg["run_id"], root)
    tp = timeline_paths(cfg, source["source_id"], root)
    utts = read_jsonl(tp["views_all"] / "utterances.jsonl")
    events = read_jsonl(tp["views_all"] / "events.jsonl")
    coverage = load_coverage(tp["coverage"])
    decisions = load_boundary_decisions(tp["boundaries"])
    ann = annotation_paths(source["source_id"], root)
    roster_path = roster_path or (ann.root / "private" / "roster_v2.json")
    roster = load_roster_v2(roster_path) if roster_path.exists() else None

    manifest = load_manifest(root)
    game = next(g for g in manifest["games"] if g["game_id"] == source["game_id"])
    forbidden = [
        source["source_id"], source["video_sha256"], cfg["source"].get("bvid"), cfg["source"].get("url"),
        cfg["source"].get("aid"), cfg["source"].get("cid"), game["game_id"], cfg["source"].get("title"), cfg["source"].get("uploader"),
    ]
    view_for_cutoff = [r for r in events + utts if r.get("review_status") != "rejected"]
    manifest["samples"] = [s for s in manifest["samples"] if not (s["game_id"] == game["game_id"] and s["dataset"] == dataset and s.get("format") == "x2" and s.get("run_id") == cfg["run_id"])]
    out = []
    for spec in cfg.get("cutoffs", []):
        try:
            rec = resolve_cutoff([r for r in view_for_cutoff if "event_id" in r], [r for r in view_for_cutoff if "utterance_id" in r], spec["after"])
            seq = rec["sequence"]
            sid = sample_id_v2(game["game_id"], dataset, perspective, seq, cfg["run_id"])
            x = build_x_v2(utterances=utts, events=events, coverage=coverage, boundary_decisions=decisions, turns_cfg=cfg.get("turns"),
                           cutoff_sequence=seq, rules=cfg["rules"], sample_id=sid, dataset=dataset, perspective=perspective)
        except ValueError as e:
            out.append({"label": spec["label"], "status": "skipped", "reason": str(e)})
            continue
        errs = record_errors(x, "sample_x_v2", forbidden_strings=[f for f in forbidden if f])
        if errs:
            raise ValidationFailed([f"X2 {spec['label']}: {m}" for m in errs])
        y = build_y_v2(roster, sid, dataset)
        errs = record_errors(y, "sample_y_v2")
        if errs:
            raise ValidationFailed([f"Y2 {spec['label']}: {m}" for m in errs])
        xb = x_bytes(x)
        yb = (canonical_json(y) + "\n").encode("utf-8")
        prefix = "draft-" if dataset == "draft" else ""
        write_bytes(run.root / "samples_v2" / dataset / "X" / f"{prefix}{sid}.json", xb)
        write_bytes(run.root / "samples_v2" / dataset / "Y" / f"{prefix}{sid}.json", yb)
        entry = {
            "sample_id": sid, "game_id": game["game_id"], "group_id": game["group_id"], "split": game["split"],
            "dataset": dataset, "cutoff_sequence": seq, "cutoff_label": spec["label"],
            "cutoff_public_at": rec["availability"]["public_at"], "perspective": perspective,
            "x_sha256": sha256_bytes(xb), "y_sha256": sha256_bytes(yb), "history_items": len(x["timeline"]),
            "format": "x2", "run_id": cfg["run_id"],
        }
        manifest["samples"].append(entry)
        out.append(dict(entry, label=spec["label"], status="written", scoring_mode=y["scoring_mode"]))
    save_manifest(manifest, root)
    return out
