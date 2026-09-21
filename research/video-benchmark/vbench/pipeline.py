"""Public extraction pipeline: scan -> OCR -> captions/speakers/board -> ASR -> utterances -> events.

This module must never import `private_labels` or read `private/` paths
(tests/test_leakage.py checks the import graph).
"""

from __future__ import annotations

import time
from pathlib import Path

import cv2

from . import PIPELINE_VERSION
from .asr import AsrConfig, asr_segment_records, engine_version, transcribe_interval
from .board import BOARD_STAGE_VERSION, events_from_snapshots, parse_board, snapshot_record
from .client_log import parse_client_log
from .cache import CacheStats, StageCache
from .textnorm import similar
from .captions import CaptionConfig, LabelPart, OcrPart, build_captions, build_speaker_segments, parse_label
from .changes import SamplingConfig, scan
from .layout import Layout, load_layout
from .media import ConversionCounter, FrameRef, iter_video_frames, video_fps
from .ocr import OcrEngine, ink_fraction, join_boxes, make_engine, run_ocr_cached
from .paths import PROJECT_ROOT, RunPaths, cache_dir, data_root, run_paths
from .speech_events import extract_statements
from .util import sha256_json, short_id, write_bytes, write_json, write_jsonl
from .utterances import build_utterances
from .validate import ValidationFailed, collection_errors, record_errors

OCR_MODE = {"caption": "line", "speaker_label": "line", "board": "page2x"}
BLANK_INK = {"caption": 0.004}


def load_config(path: str | Path) -> dict:
    from .util import read_json

    cfg = read_json(path)
    errs = record_errors(cfg, "pilot_config")
    if errs:
        raise ValidationFailed(errs)
    return cfg


def resolve_layout(cfg: dict) -> Layout:
    p = Path(cfg["layout"])
    return load_layout(p if p.is_absolute() else PROJECT_ROOT / p)


class ExtractContext:
    def __init__(self, cfg: dict, source: dict, root: Path | None = None, engine: OcrEngine | None = None, cache_root: Path | None | str = "default"):
        self.cfg = cfg
        self.root = root or data_root()
        self.run: RunPaths = run_paths(cfg["run_id"], self.root)
        self.layout = resolve_layout(cfg)
        self.source = source
        self.stats = CacheStats()
        self.cache = StageCache(cache_dir(self.root) if cache_root == "default" else cache_root, self.stats)
        self.engine = engine or make_engine(cfg["ocr"]["engine"])
        self.counters: dict[str, int] = {}
        self.timings: dict[str, float] = {}
        self.player_count = cfg["rules"].get("player_count", 10)

    def bump(self, k: str, n: int = 1) -> None:
        self.counters[k] = self.counters.get(k, 0) + n

    def provenance(self, stage: str, version: str, tool: str, tool_version: str = "") -> dict:
        return {
            "stage": stage,
            "stage_version": version,
            "tool": tool,
            "tool_version": tool_version or PIPELINE_VERSION,
            "config_sha256": sha256_json({k: self.cfg[k] for k in ("sampling", "captions", "ocr", "asr", "interval")} | {"layout": self.layout.doc}),
        }


def _save_crop(ctx: ExtractContext, region_id: str, crop, crop_sha: str) -> str:
    rel = f"public/crops/{region_id}/{crop_sha[:16]}.png"
    path = ctx.run.root / rel
    if not path.exists():
        ok, buf = cv2.imencode(".png", crop)
        write_bytes(path, buf.tobytes())
    return rel


def _ocr_sample(ctx: ExtractContext, region, seg_id: str, sample, role: str, observations: list[dict], mode: str | None = None):
    mode = mode or region.ocr_mode or OCR_MODE[region.kind]
    boxes, hit, crop_sha = run_ocr_cached(ctx.engine, ctx.cache, sample.crop, mode)
    ctx.bump("ocr_calls" if not hit else "ocr_cache_hits")
    crop_path = _save_crop(ctx, region.id, sample.crop, crop_sha)
    evidence_id = short_id("ev", ctx.source["video_sha256"], region.id, sample.frame_index, crop_sha)
    obs = {
        "schema": "vbench.ocr_observation/1",
        "ocr_id": short_id("ocr", evidence_id, ctx.engine.version_key(), mode),
        "evidence_id": evidence_id,
        "region_id": region.id,
        "segment_id": seg_id,
        "frame_index": sample.frame_index,
        "video_time": round(sample.time, 4),
        "crop_rect": list(region.rect),
        "crop_sha256": crop_sha,
        "crop_path": crop_path,
        "role": role,
        "engine": {"name": ctx.engine.name, "version_key": ctx.engine.version_key(), "mode": mode},
        "boxes": boxes,
        "text": join_boxes(boxes),
        "cache_hit": hit,
    }
    observations.append(obs)
    return obs


def run_extract(
    cfg: dict,
    source: dict,
    root: Path | None = None,
    frames=None,
    fps: float | None = None,
    engine: OcrEngine | None = None,
    asr_segments_override: list[dict] | None = None,
    cache_root: Path | None | str = "default",
) -> dict:
    ctx = ExtractContext(cfg, source, root, engine, cache_root)
    t_all = time.perf_counter()
    start, end = cfg["interval"]["start"], cfg["interval"]["end"]
    video = source.get("video")
    fps = fps or video_fps(video)
    decode = ConversionCounter()
    frames = frames if frames is not None else iter_video_frames(video, start, end, decode)
    sampling = SamplingConfig.from_dict(cfg["sampling"])

    t = time.perf_counter()
    segments, scan_stats = scan(frames, ctx.layout, sampling, fps)
    ctx.timings["scan_s"] = time.perf_counter() - t

    # ── OCR on representative + guard samples of public segments ──────────
    t = time.perf_counter()
    observations: list[dict] = []
    caption_parts: dict[str, list[OcrPart]] = {}
    label_parts: list[LabelPart] = []
    board_snaps: list[dict] = []
    src_sha = source["video_sha256"]
    for region in ctx.layout.public_regions():
        cfg_sha = ctx.layout.region_config_sha(region.id)
        for seg in segments[region.id]:
            seg_id = short_id("seg", src_sha, region.id, cfg_sha, seg.start_index, seg.end_index)
            ctx.bump(f"segments_{region.kind}")
            rep = seg.representative() if seg.present else None
            too_short = seg.n_frames < sampling.min_ocr_frames
            if rep is None or too_short:
                if seg.present and too_short:
                    ctx.bump(f"skipped_short_{region.kind}")
                if region.kind == "speaker_label":
                    label_parts.append(LabelPart(seg_id, seg.start_time, seg.end_time, False, None, None))
                continue
            if region.kind in BLANK_INK and ink_fraction(rep.crop) < BLANK_INK[region.kind]:
                ctx.bump(f"skipped_blank_{region.kind}")
                continue
            obs = _ocr_sample(ctx, region, seg_id, rep, "representative", observations)
            if (
                region.kind == "caption"
                and cfg["ocr"].get("empty_line_fallback", False)
                and not obs["text"].strip()
            ):
                # v2 fix: recognition-only mode returns '' for a lone centred character
                # in a wide crop (pilot 11.07 s '呃'); ink is present, so detect first.
                obs = _ocr_sample(ctx, region, seg_id, rep, "representative", observations, mode="page")
                ctx.bump("ocr_empty_line_fallbacks")
            guards = []
            for g in seg.guards:
                if g.frame_index == rep.frame_index:
                    continue
                gobs = _ocr_sample(ctx, region, seg_id, g, "guard", observations)
                guards.append((gobs["text"], gobs["ocr_id"]))
            scores = [b["score"] for b in obs["boxes"] if b.get("score") is not None]
            if region.kind == "caption":
                caption_parts.setdefault(region.id, []).append(OcrPart(seg_id, seg.start_time, seg.end_time, obs["text"], min(scores) if scores else None, obs["ocr_id"], guards, obs["crop_path"]))
            elif region.kind == "speaker_label":
                label_parts.append(LabelPart(seg_id, seg.start_time, seg.end_time, True, obs["text"], obs["ocr_id"], guards, obs["crop_path"]))
            elif region.kind == "board":
                # Which surface this is (offline board vs online client panel) is a
                # property of the source, so the layout names the reader.
                if getattr(region, "parser", None) == "client_log":
                    missions, warnings = parse_client_log(obs["boxes"], rep.crop, ctx.player_count)
                else:
                    missions, warnings = parse_board(obs["boxes"], rep.crop, ctx.player_count,
                                                     getattr(region, "cells", None))
                for gtext, gid in guards:
                    # Guards read the same stable segment; a different reading means
                    # either OCR jitter or a change the pixel diff did not see.
                    if not similar(gtext, obs["text"], cfg["captions"]["jitter_cer"]):
                        warnings.append(f"guard_mismatch: {gid} reads differently from the representative frame")
                board_snaps.append(snapshot_record(src_sha, seg.start_time, seg.end_time, obs["crop_sha256"], [obs["ocr_id"]] + [gid for _, gid in guards], missions, warnings, obs["crop_path"]))
    ctx.timings["ocr_s"] = time.perf_counter() - t

    # ── captions / speakers / board events ───────────────────────────────
    speakers = build_speaker_segments(label_parts, ctx.player_count, src_sha)
    frame_s = 1.0 / fps

    def seat_at(tm: float):
        for s in speakers:
            if s["start"] <= tm < s["end"]:
                return s["seat"]
        return None

    # Each caption region (yellow-bar subtitles, bar-less plain subtitles) is
    # deduplicated on its own; their display intervals never overlap because the
    # plain region only exists while the bar is absent.
    captions = []
    for creg in ctx.layout.regions_of_kind("caption", "public"):
        captions += build_captions(caption_parts.get(creg.id, []), CaptionConfig.from_dict(cfg["captions"], frame_s), src_sha, creg.id, seat_at)
    captions.sort(key=lambda c: c["display_start"])
    board_events = events_from_snapshots(board_snaps, src_sha, ctx.player_count, ctx.provenance("board", BOARD_STAGE_VERSION, "rule-parser"))

    # ── ASR ──────────────────────────────────────────────────────────────
    t = time.perf_counter()
    asr_cfg = AsrConfig.from_dict(cfg["asr"])
    asr_records: list[dict] | None = None
    asr_mode = "unavailable"
    asr_note = None
    if asr_segments_override is not None:
        asr_records, asr_mode = asr_segments_override, "fake"
    elif asr_cfg.backend == "faster-whisper" and source.get("audio") and source.get("audio_sha256"):
        try:
            raw, hit = transcribe_interval(source["audio"], source["audio_sha256"], start, end, asr_cfg, ctx.root / "models", ctx.cache)
            ctx.bump("asr_cache_hits" if hit else "asr_calls")
            asr_records = asr_segment_records(raw, src_sha, asr_cfg, engine_version(asr_cfg))
            asr_mode = "faster-whisper"
        except Exception as e:  # noqa: BLE001 - recorded, and output is explicitly caption-only
            asr_note = f"ASR failed, output is subtitle-only: {type(e).__name__}: {e}"
    else:
        asr_note = "ASR backend disabled or no audio: output is subtitle-only"
    ctx.timings["asr_s"] = time.perf_counter() - t

    utterances = build_utterances(
        captions, speakers, asr_records, asr_mode, src_sha,
        ctx.provenance("utterances", "1", "rule-merge"),
        asr_cfg.agree_cer, asr_cfg.minor_cer, asr_cfg.pad_s,
    )
    # Semantic statement extraction is out of scope since the timeline revision;
    # kept only for reproducing the v1 pilot, which enables it explicitly.
    speech_events = (
        extract_statements(utterances, src_sha, ctx.provenance("speech_events", "1", "rule-parser"))
        if cfg.get("speech_events", {}).get("enabled", False)
        else []
    )
    events = board_events + speech_events

    # ── validate and write ───────────────────────────────────────────────
    errors: list[str] = []
    rules = cfg["rules"]
    for name, rows, id_key in (
        ("ocr_observation", observations, "ocr_id"),
        ("caption_segment", captions, "caption_segment_id"),
        ("speaker_segment", speakers, "speaker_segment_id"),
        ("board_snapshot", board_snaps, "snapshot_id"),
        ("asr_segment", asr_records or [], "asr_segment_id"),
        ("utterance", utterances, "utterance_id"),
        ("public_event", events, "event_id"),
    ):
        for r in rows:
            errors += record_errors(r, name, rules=rules)
        if name != "ocr_observation":
            errors += collection_errors(rows, id_key)
    pub = ctx.run.public
    write_jsonl(pub / "ocr_raw.jsonl", observations)
    write_jsonl(pub / "caption_segments.jsonl", captions)
    write_jsonl(pub / "speaker_segments.jsonl", speakers)
    write_jsonl(pub / "board_snapshots.jsonl", board_snaps)
    write_jsonl(pub / "asr_segments.jsonl", asr_records or [])
    write_jsonl(pub / "utterances.jsonl", utterances)
    write_jsonl(pub / "events.jsonl", events)
    ctx.timings["total_s"] = time.perf_counter() - t_all
    stats = {
        "run_id": cfg["run_id"],
        "pipeline_version": PIPELINE_VERSION,
        "interval": {"start": start, "end": end, "processed_s": round((scan_stats.last_time or start) - (scan_stats.first_time or start) + frame_s, 3)},
        "sampling": dict(cfg["sampling"], fps=fps, boundary_precision_s=round(frame_s, 4), coarse_period_s=round(sampling.coarse_step_frames / fps, 4)),
        "scan": scan_stats.as_dict(),
        "decode": {"frames_decoded": decode.decoded, "corrupt_packets": len(decode.decode_errors), "corrupt_packet_times": decode.decode_errors[:50]},
        "counters": ctx.counters,
        "cache": ctx.stats.as_dict(),
        "timings_s": {k: round(v, 3) for k, v in ctx.timings.items()},
        "asr": {"mode": asr_mode, "note": asr_note, "params": asr_cfg.params() if asr_mode == "faster-whisper" else None},
        "outputs": {
            "ocr_observations": len(observations), "caption_segments": len(captions), "speaker_segments": len(speakers),
            "board_snapshots": len(board_snaps), "asr_segments": len(asr_records or []), "utterances": len(utterances),
            "board_events": len(board_events), "speech_events": len(speech_events),
        },
        "external_usage": {"paid_api_calls": 0, "network_calls_during_extract": 0},
        "validation_errors": errors[:50],
        "validation_error_count": len(errors),
    }
    write_json(pub / "extract_stats.json", stats)
    return stats
