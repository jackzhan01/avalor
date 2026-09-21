"""Caption segments from OCR'd subtitle segments, and speaker segments from labels."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .textnorm import normalize_for_compare, similar
from .util import short_id

CAPTIONS_STAGE_VERSION = "1"


@dataclass
class OcrPart:
    """One pixel-stable region segment that has been OCR'd."""

    segment_id: str
    start: float
    end: float
    text: str
    score: float | None
    ocr_ref: str
    guard_texts: list[tuple[str, str]] = field(default_factory=list)  # (text, ocr_id)
    crop_path: str | None = None
    start_exact: bool = True


@dataclass
class CaptionConfig:
    merge_gap_s: float = 0.35
    jitter_cer: float = 0.25
    short_s: float = 0.4
    low_score: float = 0.8
    # fuzzy_v1: merge any adjacent similar parts (pilot v1; merged a real one-character
    # editor change). short_part_v2: fuzzy-merge only when one part is a short
    # animation/fade fragment; long similar neighbours stay separate and flagged.
    merge_policy: str = "fuzzy_v1"
    frame_s: float = 1 / 30

    @classmethod
    def from_dict(cls, d: dict, frame_s: float) -> "CaptionConfig":
        kw = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**kw, frame_s=frame_s)


def build_captions(
    parts: list[OcrPart],
    cfg: CaptionConfig,
    source_sha: str,
    region_id: str,
    seat_at=None,
) -> list[dict]:
    """Merge temporal persistence of the same caption; never merge globally.

    `seat_at(t)` returns the label seat at time t; parts with different seats are
    never merged even if their text is identical (two people can say "对").
    """
    parts = sorted((p for p in parts if p.text.strip()), key=lambda p: p.start)
    groups: list[list[OcrPart]] = []
    similar_neighbors: set[int] = set()
    for p in parts:
        if groups:
            g = groups[-1]
            prev = g[-1]
            main = _main_text(g)
            same_speaker = seat_at is None or seat_at((prev.start + prev.end) / 2) == seat_at((p.start + p.end) / 2)
            close = p.start - prev.end <= cfg.merge_gap_s + 1e-9 and same_speaker
            identical = normalize_for_compare(main) == normalize_for_compare(p.text)
            fuzzy = similar(main, p.text, cfg.jitter_cer)
            if cfg.merge_policy == "short_part_v2":
                short = min(p.end - p.start, sum(x.end - x.start for x in g)) < cfg.short_s
                if close and (identical or (fuzzy and short)):
                    g.append(p)
                    continue
                if close and fuzzy:
                    similar_neighbors.add(id(g[-1]))
                    similar_neighbors.add(id(p))
            elif close and fuzzy:
                g.append(p)
                continue
        groups.append([p])

    out = []
    for g in groups:
        main = _main_text(g)
        texts = [p.text for p in g] + [t for p in g for t, _ in p.guard_texts]
        alternatives = sorted({t for t in texts if t != main})
        flags = []
        if len({p.text for p in g}) > 1:
            flags.append("merged_jitter")
        if any(not similar(t, p.text, cfg.jitter_cer) for p in g for t, _ in p.guard_texts):
            flags.append("guard_mismatch")
        start, end = g[0].start, g[-1].end
        if end - start < cfg.short_s:
            flags.append("short")
        scores = [p.score for p in g if p.score is not None]
        min_score = min(scores) if scores else None
        if min_score is not None and min_score < cfg.low_score:
            flags.append("low_score")
        if any(id(p) in similar_neighbors for p in g):
            flags.append("similar_neighbor")
        rep = max(g, key=lambda p: p.end - p.start)
        out.append({
            "schema": "vbench.caption_segment/1",
            "caption_segment_id": short_id("cap", source_sha, region_id, g[0].segment_id, main),
            "region_id": region_id,
            "display_start": round(start, 4),
            "display_end": round(end, 4),
            "timing": {
                "method": "region_diff_refined_to_frame",
                "start_precision_s": round(cfg.frame_s, 4),
                "end_precision_s": round(cfg.frame_s, 4),
            },
            "text": main,
            "alternatives": alternatives,
            "ocr_refs": [p.ocr_ref for p in g] + [oid for p in g for _, oid in p.guard_texts],
            "parts": [{"segment_id": p.segment_id, "start": round(p.start, 4), "end": round(p.end, 4), "text": p.text} for p in g],
            "flags": flags,
            "min_score": None if min_score is None else round(min_score, 4),
            **({"representative_crop": rep.crop_path} if rep.crop_path else {}),
        })
    return out


def _main_text(g: list[OcrPart]) -> str:
    # The reading shown longest wins; ties go to the earliest.
    by_text: dict[str, float] = {}
    for p in g:
        by_text[p.text] = by_text.get(p.text, 0.0) + (p.end - p.start)
    return max(by_text.items(), key=lambda kv: (kv[1], -[p.text for p in g].index(kv[0])))[0]


LABEL_RE = re.compile(r"^\s*(\d{1,2})\s*(.*?)\s*$")


SEAT_TOKEN_RE = re.compile(r"(\d{1,2})\s*号")


def parse_label(text: str | None, player_count: int) -> tuple[int | None, str | None]:
    if not text:
        return None, None
    m = LABEL_RE.match(text)
    if not m:
        # A redacted label can carry a stray glyph in front of the seat token
        # ('電3号時'). An explicit '<n>号' anywhere still identifies the seat;
        # labels without '号' keep the stricter leading-digit rule.
        sm = SEAT_TOKEN_RE.search(text)
        if sm and 1 <= int(sm.group(1)) <= player_count:
            return int(sm.group(1)), None
        return None, text.strip() or None
    seat = int(m.group(1))
    if not 1 <= seat <= player_count:
        return None, m.group(2) or None
    return seat, (m.group(2) or None)


@dataclass
class LabelPart:
    segment_id: str
    start: float
    end: float
    present: bool
    text: str | None
    ocr_ref: str | None
    guard_texts: list[tuple[str, str]] = field(default_factory=list)
    crop_path: str | None = None


def build_speaker_segments(parts: list[LabelPart], player_count: int, source_sha: str) -> list[dict]:
    parts = sorted(parts, key=lambda p: p.start)
    merged: list[dict] = []
    for p in parts:
        seat, name = parse_label(p.text, player_count) if p.present else (None, None)
        label = p.text if p.present else None
        flags = []
        if p.present and seat is None:
            flags.append("unparsed_label")
        guard_seats = {parse_label(t, player_count)[0] for t, _ in p.guard_texts}
        if p.present and guard_seats and guard_seats != {seat}:
            flags.append("guard_mismatch")
        refs = ([p.ocr_ref] if p.ocr_ref else []) + [oid for _, oid in p.guard_texts]
        if merged:
            m = merged[-1]
            # Adjacent segments with the same parsed seat are one label on screen;
            # nickname OCR jitters far more than the digits do.
            if m["_present"] == p.present and m["seat"] == seat and (seat is not None or not p.present) and abs(p.start - m["end"]) < 1e-3:
                m["end"] = p.end
                m["ocr_refs"] += refs
                m["flags"] = sorted(set(m["flags"]) | set(flags))
                m["_labels"].append((label, p.end - p.start))
                continue
        merged.append({
            "_present": p.present,
            "_first_segment": p.segment_id,
            "_labels": [(label, p.end - p.start)],
            "start": p.start,
            "end": p.end,
            "seat": seat,
            "name": name,
            "ocr_refs": refs,
            "flags": flags,
            "crop": p.crop_path,
        })
    out = []
    for m in merged:
        weights: dict = {}
        for lab, d in m["_labels"]:
            weights[lab] = weights.get(lab, 0.0) + d
        label = max(weights.items(), key=lambda kv: kv[1])[0]
        _, name = parse_label(label, player_count) if label else (None, None)
        if m["end"] - m["start"] < 0.2 and "short" not in m["flags"]:
            m["flags"].append("short")
        rec = {
            "schema": "vbench.speaker_segment/1",
            "speaker_segment_id": short_id("spk", source_sha, m["_first_segment"], m["seat"], label),
            "start": round(m["start"], 4),
            "end": round(m["end"], 4),
            "label_text": label,
            "seat": m["seat"],
            "name": name,
            "ocr_refs": m["ocr_refs"],
            "flags": sorted(set(m["flags"])),
        }
        if m["crop"]:
            rec["representative_crop"] = m["crop"]
        out.append(rec)
    return out


def attribute_speaker(speakers: list[dict], start: float, end: float, stable_share: float = 0.9) -> dict:
    """Which label was on screen while this caption was displayed.

    A label identifies the featured speaker only. When the label changes
    inside the caption interval, attribution is 'label_transition' and the
    record must be reviewed; it is never silently assigned.
    """
    dur = max(end - start, 1e-6)
    overlaps: dict[tuple, float] = {}
    ids: dict[tuple, list[str]] = {}
    for s in speakers:
        ov = min(end, s["end"]) - max(start, s["start"])
        if ov <= 0:
            continue
        k = (s["label_text"], s["seat"])
        overlaps[k] = overlaps.get(k, 0.0) + ov
        ids.setdefault(k, []).append(s["speaker_segment_id"])
    seats: dict = {}
    for (lab, seat), ov in overlaps.items():
        seats[seat] = seats.get(seat, 0.0) + ov
    labels_seen = [
        {"label_text": lab, "seat": seat, "overlap_s": round(ov, 4)}
        for (lab, seat), ov in sorted(overlaps.items(), key=lambda kv: -kv[1])
    ]
    evidence = [{"kind": "speaker_segment", "id": i} for k in overlaps for i in ids[k]]
    if not seats:
        return {"seat": None, "label_text": None, "attribution": "no_label", "evidence_refs": [], "labels_seen": []}
    top_seat, top_ov = max(seats.items(), key=lambda kv: kv[1])
    top_label = max(((lab, ov) for (lab, s), ov in overlaps.items() if s == top_seat), key=lambda kv: kv[1])[0]
    distinct_real = [s for s, ov in seats.items() if s is not None and ov >= min(0.1, dur * 0.1)]
    if top_seat is None:
        attribution = "no_label"
    elif len(distinct_real) > 1 or top_ov / dur < stable_share:
        attribution = "label_transition"
    else:
        attribution = "label_stable"
    return {
        "seat": top_seat,
        "label_text": top_label,
        "attribution": attribution,
        "evidence_refs": evidence,
        "labels_seen": labels_seen,
    }
