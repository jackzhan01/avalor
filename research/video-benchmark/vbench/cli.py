"""Command line entry point: `python -m vbench <command>`. Messages are Chinese; see README for examples."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
from pathlib import Path

from .paths import PROJECT_ROOT, annotation_paths, data_root, run_paths


def _cfg(args):
    from .pipeline import load_config

    p = Path(args.config)
    return load_config(p if p.is_absolute() else Path.cwd() / p)


def _source(cfg):
    from .source import register_source

    return register_source(cfg)


def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def cmd_doctor(args):
    from importlib.metadata import PackageNotFoundError, version

    report = {"python": sys.version.split()[0], "platform": platform.platform(), "data_root": str(data_root())}
    pins = {}
    req = PROJECT_ROOT / "requirements.txt"
    for line in req.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "==" not in line:
            continue
        name, want = line.split("==")
        try:
            have = version(name)
        except PackageNotFoundError:
            have = None
        pins[name] = {"pinned": want, "installed": have, "ok": have == want}
    report["packages"] = pins
    try:
        import av

        report["pyav_h264_decoder"] = "h264" in av.codecs_available
        report["pyav_ffmpeg"] = {k: ".".join(map(str, v)) if isinstance(v, tuple) else v for k, v in av.library_versions.items()}
    except Exception as e:  # noqa: BLE001
        report["pyav_error"] = repr(e)
    try:
        import onnxruntime

        report["onnxruntime_providers"] = onnxruntime.get_available_providers()
    except Exception as e:  # noqa: BLE001
        report["onnxruntime_error"] = repr(e)
    try:
        import ctranslate2

        report["ctranslate2_cuda_devices"] = ctranslate2.get_cuda_device_count()
    except Exception as e:  # noqa: BLE001
        report["ctranslate2_error"] = repr(e)
    models = data_root() / "models"
    report["whisper_models_present"] = sorted(p.name for p in models.glob("models--*")) if models.exists() else []
    root = data_root()
    root.mkdir(parents=True, exist_ok=True)
    report["disk_free_gb"] = round(shutil.disk_usage(root).free / 1e9, 1)
    if args.fetch_asr_model:
        from faster_whisper.utils import download_model

        report["downloaded_model"] = download_model(args.fetch_asr_model, cache_dir=str(models))
    report["all_pins_ok"] = all(v["ok"] for v in pins.values())
    _print(report)
    return 0 if report["all_pins_ok"] else 1


def cmd_acquire(args):
    from .source import acquire

    cfg = _cfg(args)
    paths = acquire(cfg)
    src = _source(cfg)
    _print({"downloaded": [str(p) for p in paths], "source_id": src["source_id"], "video_sha256": src["video_sha256"]})


def cmd_ingest(args):
    cfg = _cfg(args)
    src = _source(cfg)
    _print({"source_id": src["source_id"], "video_sha256": src["video_sha256"], "audio_sha256": src["audio_sha256"], "probe": src["record"]["probe"]})


def cmd_inspect_layout(args):
    import cv2

    from .layout import apply_redactions, crop_region, draw_overlay, presence_fraction, presence_map, public_crops
    from .media import grab_frames
    from .pipeline import resolve_layout
    from .util import write_bytes

    cfg = _cfg(args)
    src = _source(cfg)
    layout = resolve_layout(cfg)
    run = run_paths(cfg["run_id"])
    times = [float(t) for t in args.times.split(",")]
    rows = []
    for t, frame in grab_frames(src["video"], times):
        # Same order the scanner uses: gate on the untouched overlay, then redact.
        raw = public_crops(frame, layout, redact=False)
        pres = presence_map(raw, layout)
        crops = apply_redactions(raw, layout)
        entry = {"time": round(t, 3), "regions": {}}
        for r in layout.public_regions():
            entry["regions"][r.id] = {"presence_fraction": presence_fraction(raw[r.id], r), "present": pres[r.id]}
            ok, buf = cv2.imencode(".png", crops[r.id])
            write_bytes(run.review / "layout" / f"{r.id}_{t:08.3f}.png", buf.tobytes())
        # Full frames with overlays show the roster: private authoring artifact.
        ok, buf = cv2.imencode(".jpg", cv2.resize(draw_overlay(frame, layout), (960, 540)))
        write_bytes(run.private / "authoring" / f"frame_{t:08.3f}.jpg", buf.tobytes())
        rows.append(entry)
    _print({"layout": layout.layout_id, "frames": rows, "public_crops_dir": str(run.review / "layout"), "private_frames_dir": str(run.private / "authoring")})


def cmd_extract(args):
    from .pipeline import run_extract
    from .review import build_review_queue

    cfg = _cfg(args)
    src = _source(cfg)
    stats = run_extract(cfg, src)
    q = build_review_queue(cfg, src["source_id"])
    _print({k: stats[k] for k in ("interval", "scan", "decode", "counters", "cache", "timings_s", "asr", "outputs", "validation_error_count")} | {"review_queue": q})
    return 1 if stats["validation_error_count"] else 0


def cmd_dense_check(args):
    from .dense import dense_check
    from .media import video_fps
    from .pipeline import resolve_layout

    cfg = _cfg(args)
    src = _source(cfg)
    run = run_paths(cfg["run_id"])
    res = dense_check(src["video"], resolve_layout(cfg), cfg["sampling"], video_fps(src["video"]), args.start, args.end, run.review / "dense", args.strip_every)
    _print({k: v for k, v in res.items() if k != "dense_scan"})


def cmd_reference_sheets(args):
    from .dense import reference_sheets
    from .media import video_fps
    from .pipeline import resolve_layout

    cfg = _cfg(args)
    src = _source(cfg)
    run = run_paths(cfg["run_id"])
    start = cfg["interval"]["start"] if args.start is None else args.start
    end = cfg["interval"]["end"] if args.end is None else args.end
    _print(reference_sheets(src["video"], resolve_layout(cfg), cfg["sampling"], video_fps(src["video"]), start, end, run.review / "reference_sheets"))


def cmd_review_export(args):
    from .review import build_review_queue

    cfg = _cfg(args)
    src = _source(cfg)
    _print(build_review_queue(cfg, src["source_id"]))


def _machine_index(cfg):
    from .util import read_jsonl

    run = run_paths(cfg["run_id"])
    return {
        "utterance": {u["utterance_id"]: u for u in read_jsonl(run.public / "utterances.jsonl")},
        "public_event": {e["event_id"]: e for e in read_jsonl(run.public / "events.jsonl")},
    }


def cmd_corrections_import(args):
    """Fill ids/revisions/content hashes for reviewer-written rows and append them."""
    from .corrections import append_corrections, content_sha, make_correction
    from .util import read_jsonl

    cfg = _cfg(args)
    src = _source(cfg)
    ann = annotation_paths(src["source_id"])
    idx = _machine_index(cfg)
    target_file = ann.run_corrections(cfg["run_id"]) if args.run_scoped else ann.corrections
    existing = read_jsonl(target_file)
    added = {c["target"]["id"]: c["value"] for c in read_jsonl(ann.corrections) + read_jsonl(ann.run_corrections(cfg["run_id"])) if c["op"] == "add"}
    new_rows, problems = [], []
    for i, row in enumerate(read_jsonl(Path(args.file))):
        kind, tid = row["target"]["kind"], row["target"]["id"]
        target = None
        if row["op"] != "add":
            target = idx[kind].get(tid) or added.get(tid)
            if target is None:
                problems.append(f"line {i + 1}: target {tid} not found in current machine records")
                continue
            if row["target"].get("content_sha256") and row["target"]["content_sha256"] != content_sha(target):
                problems.append(f"line {i + 1}: target {tid} changed since the reviewer saw it (stale)")
                continue
        new_rows.append(make_correction(
            existing + new_rows, kind=kind, target=target, target_id=tid, op=row["op"], path=row.get("path"),
            value=row.get("value"), reviewer=row.get("reviewer", args.reviewer), note=row.get("note", ""),
            supersedes=row.get("supersedes"), evidence_refs=row.get("evidence_refs"),
        ))
    if problems and not args.skip_problems:
        _print({"appended": 0, "problems": problems})
        return 1
    append_corrections(target_file, new_rows)
    _print({"appended": len(new_rows), "problems": problems, "corrections_file": str(target_file)})


def cmd_build(args):
    from .views import build_views

    cfg = _cfg(args)
    src = _source(cfg)
    _print(build_views(cfg, src["source_id"], persist_ledger=not args.dry_run))


def cmd_samples(args):
    from .export import export_samples
    from .samples import UnsupportedPerspective

    cfg = _cfg(args)
    src = _source(cfg)
    try:
        out = export_samples(cfg, src, args.dataset, perspective=args.perspective)
    except UnsupportedPerspective as e:
        print(f"拒绝导出：{e}", file=sys.stderr)
        return 2
    _print(out)


def cmd_private_roster(args):
    from .ocr import RapidOcrEngine
    from .pipeline import resolve_layout
    from .private_labels import roster_evidence

    cfg = _cfg(args)
    src = _source(cfg)
    run = run_paths(cfg["run_id"])
    times = [float(t) for t in (args.times.split(",") if args.times else cfg.get("private", {}).get("roster_times", []))]
    ev = roster_evidence(src["video"], resolve_layout(cfg), times, run.private / "roster", RapidOcrEngine() if args.ocr else None)
    print(f"已写入 {len(ev)} 张名单裁剪到私有目录 {run.private / 'roster'}（不要把它们放进公开审阅产物）")


def cmd_private_validate(args):
    from .private_labels import load_roles

    cfg = _cfg(args)
    src = _source(cfg)
    path = Path(args.file) if args.file else annotation_paths(src["source_id"]).private_roles
    doc = load_roles(path)
    counts = {}
    for s in doc["seats"]:
        counts[s["verification"]] = counts.get(s["verification"], 0) + 1
    print(f"私有身份文件有效：{path}；verification 计数 {counts}（不打印身份本身）")


def cmd_validate(args):
    from .validate import validate_path

    bad = 0
    for p in args.paths:
        n, errs = validate_path(Path(p))
        status = "OK" if not errs else f"{len(errs)} errors"
        print(f"{p}: {n} records, {status}")
        for e in errs[:20]:
            print("   ", e)
        bad += bool(errs)
    return 1 if bad else 0


def cmd_report(args):
    from .report import build_report

    cfg = _cfg(args)
    src = _source(cfg)
    rep = build_report(cfg, src["source_id"])
    run = run_paths(cfg["run_id"])
    print((run.reports / "pilot_report.md").read_text(encoding="utf-8"))


# ── timeline revision commands ─────────────────────────────────────────────


def cmd_timeline(args):
    from .timeline_build import build_timeline

    cfg = _cfg(args)
    src = _source(cfg)
    datasets = ("accepted", "draft") if args.dataset == "both" else (args.dataset,)
    summary = build_timeline(cfg, src["source_id"], datasets)
    _print(summary)
    return 1 if any(v["errors"] for v in summary.values()) else 0


def cmd_samples_v2(args):
    from .export import export_samples_v2
    from .samples import UnsupportedPerspective

    cfg = _cfg(args)
    src = _source(cfg)
    try:
        out = export_samples_v2(cfg, src, args.dataset, perspective=args.perspective)
    except UnsupportedPerspective as e:
        print(f"拒绝导出：{e}", file=sys.stderr)
        return 2
    _print(out)


def cmd_migrate_corrections(args):
    from .migrate import migrate_corrections

    cfg = _cfg(args)
    src = _source(cfg)
    old = _cfg(argparse.Namespace(config=args.from_config))
    rep = migrate_corrections(old, cfg, src["source_id"], args.reviewer, dry_run=args.dry_run)
    _print({"counts": rep["counts"], "report": str(annotation_paths(src["source_id"]).root / "migrations" / f"{old['run_id']}__{cfg['run_id']}.json")})


def cmd_turn_boundaries_import(args):
    from .timeline_build import make_boundary_correction
    from .util import append_jsonl, read_jsonl
    from .validate import ValidationFailed, record_errors

    cfg = _cfg(args)
    src = _source(cfg)
    ann = annotation_paths(src["source_id"])
    path = ann.root / f"turn_boundaries.{cfg['run_id']}.jsonl"
    views = {u["utterance_id"]: u for u in read_jsonl(run_paths(cfg["run_id"]).views / "all" / "utterances.jsonl")}
    existing = read_jsonl(path)
    rows, problems = [], []
    for i, r in enumerate(read_jsonl(Path(args.file))):
        b, a = views.get(r["before"]), views.get(r["after"])
        if b is None or a is None:
            problems.append(f"line {i + 1}: segment not in current views")
            continue
        rows.append(make_boundary_correction(existing + rows, before=b, after=a, decision=r["decision"], reviewer=r.get("reviewer", args.reviewer), note=r.get("note", ""), supersedes=r.get("supersedes")))
    errs = [m for row in rows for m in record_errors(row, "turn_boundary_correction")]
    if errs or (problems and not args.skip_problems):
        _print({"appended": 0, "problems": problems, "errors": errs})
        return 1
    append_jsonl(path, rows)
    _print({"appended": len(rows), "problems": problems, "file": str(path)})


def cmd_private_roster_v2(args):
    from .media import probe
    from .ocr import RapidOcrEngine
    from .pipeline import resolve_layout
    from .private_labels import build_roster_v2, load_roles, roster_v2_errors
    from .util import write_json
    from .validate import schema_errors

    cfg = _cfg(args)
    src = _source(cfg)
    ann = annotation_paths(src["source_id"])
    run = run_paths(cfg["run_id"])
    times = [float(t) for t in args.times.split(",")]
    doc = build_roster_v2(load_roles(ann.private_roles), src["video"], resolve_layout(cfg), times,
                          run.private / "roster_v2", RapidOcrEngine(), probe(src["video"])["container_duration_s"],
                          reveal_note=args.reveal_note)
    errs = schema_errors("private_roster", doc) or roster_v2_errors(doc)
    if errs:
        _print({"errors": errs})
        return 1
    write_json(ann.root / "private" / "roster_v2.json", doc)
    counts = {}
    for st in doc["seats"]:
        counts[st["verification"]] = counts.get(st["verification"], 0) + 1
    print(f"私有名单 v2 已写入 {ann.root / 'private' / 'roster_v2.json'}；verification 计数 {counts}；各座位一致性检查次数 {[len(st['consistency']['checked_times']) for st in doc['seats']]}（不打印身份）")


def cmd_review_sheets_v2(args):
    from .review_sheets import build_review_sheets

    cfg = _cfg(args)
    run = run_paths(cfg["run_id"])
    rec = run.root / "timeline_v2" / args.dataset / "game_record.json"
    _print(build_review_sheets(run.root, rec, args.start, args.end, run.review / "sheets_v2"))


def cmd_agent_pairs(args):
    from .agent_pairs import build_agent_pairs
    from .samples import UnsupportedPerspective

    cfg = _cfg(args)
    src = _source(cfg)
    questions = [q for q in (args.open_question or [])]
    try:
        out = build_agent_pairs(cfg, src, args.dataset, perspective=args.perspective, open_questions=questions,
                                revision=args.revision or "", revision_reason=list(args.revision_reason or []))
    except UnsupportedPerspective as e:
        print(f"拒绝导出：{e}", file=sys.stderr)
        return 2
    _print({"out_dir": out["out_dir"], "manifest": out["manifest"], "instruction": out["instruction"],
            "skipped": out["skipped"], "nickname_mentions": out["nickname_mentions"],
            "pairs": [{k: p[k] for k in ("sample_id", "kind", "cutoff_label", "input_path", "label_path", "size")} for p in out["pairs"]]})


def cmd_report_v2(args):
    from .report_v2 import build_report_v2

    cfg = _cfg(args)
    src = _source(cfg)
    build_report_v2(cfg, src["source_id"])
    print((run_paths(cfg["run_id"]).reports / "timeline_v2_report.md").read_text(encoding="utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="vbench", description="阿瓦隆视频标注试点管线")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, config=True):
        p = sub.add_parser(name)
        if config:
            p.add_argument("--config", required=True)
        p.set_defaults(fn=fn)
        return p

    p = add("doctor", cmd_doctor, config=False)
    p.add_argument("--fetch-asr-model", default=None, help="例如 large-v3；会联网下载权重到数据目录")
    add("acquire", cmd_acquire)
    add("ingest", cmd_ingest)
    p = add("inspect-layout", cmd_inspect_layout)
    p.add_argument("--times", required=True)
    add("extract", cmd_extract)
    p = add("dense-check", cmd_dense_check)
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    p.add_argument("--strip-every", type=int, default=6)
    add("review-export", cmd_review_export)
    p = add("reference-sheets", cmd_reference_sheets)
    p.add_argument("--start", type=float, default=None)
    p.add_argument("--end", type=float, default=None)
    p = add("corrections-import", cmd_corrections_import)
    p.add_argument("--file", required=True)
    p.add_argument("--reviewer", default="unknown")
    p.add_argument("--skip-problems", action="store_true")
    p.add_argument("--run-scoped", action="store_true", help="写入 corrections.<run_id>.jsonl（迁移/新审阅），而不是共享文件")
    p = add("build", cmd_build)
    p.add_argument("--dry-run", action="store_true", help="不写序号账本（预览草稿用）")
    p = add("samples", cmd_samples)
    p.add_argument("--dataset", choices=["accepted", "draft"], default="accepted")
    p.add_argument("--perspective", default="public_observer")
    p = add("private-roster", cmd_private_roster)
    p.add_argument("--times", default=None)
    p.add_argument("--ocr", action="store_true")
    p = add("private-validate", cmd_private_validate)
    p.add_argument("--file", default=None)
    p = add("validate", cmd_validate, config=False)
    p.add_argument("paths", nargs="+")
    add("report", cmd_report)
    p = add("timeline", cmd_timeline)
    p.add_argument("--dataset", choices=["accepted", "draft", "both"], default="both")
    p = add("samples-v2", cmd_samples_v2)
    p.add_argument("--dataset", choices=["accepted", "draft"], default="accepted")
    p.add_argument("--perspective", default="public_observer")
    p = add("migrate-corrections", cmd_migrate_corrections)
    p.add_argument("--from-config", required=True)
    p.add_argument("--reviewer", default="claude-code (migration)")
    p.add_argument("--dry-run", action="store_true")
    p = add("agent-pairs", cmd_agent_pairs)
    p.add_argument("--dataset", choices=["accepted", "draft"], default="accepted")
    p.add_argument("--perspective", default="public_observer")
    p.add_argument("--open-question", action="append", help="写进每份 audit.json 的待复核问题，可多次给出")
    p.add_argument("--revision", default="", help="修订标签：写到 agent_pairs_v3_<标签>/，并进入 sample_id，绝不覆盖原目录")
    p.add_argument("--revision-reason", action="append", help="本次修订的原因，写进 manifest 的 revision_of，可多次给出")
    add("report-v2", cmd_report_v2)
    p = add("review-sheets-v2", cmd_review_sheets_v2)
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    p.add_argument("--dataset", choices=["accepted", "draft"], default="draft")
    p = add("private-roster-v2", cmd_private_roster_v2)
    p.add_argument("--times", required=True)
    p.add_argument("--reveal-note", default=None,
                   help="片尾身份揭示的实际情况，由核对过的人写；不给就只说本函数没判断")
    p = add("turn-boundaries-import", cmd_turn_boundaries_import)
    p.add_argument("--file", required=True)
    p.add_argument("--reviewer", default="unknown")
    p.add_argument("--skip-problems", action="store_true")

    args = ap.parse_args(argv)
    rc = args.fn(args)
    return int(rc or 0)
