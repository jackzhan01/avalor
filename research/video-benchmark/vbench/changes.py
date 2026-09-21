"""Region-based change detection over public crops.

Cost model: H.264 must decode every frame anyway, but converting a frame to
BGR and diffing crops is the part we can skip. So:

1. coarse: every `coarse_step_frames`-th frame is converted and its public
   crops compared with the previous sample and with the segment reference;
2. refine: when a sample differs, the buffered frames since the last sample
   are converted and walked in order, so boundaries land on the exact frame;
3. guard: stable segments still keep crops every `guard_period_s`, which are
   OCR'd separately so a change the diff missed shows up as a text mismatch.

Recall limit (measured in the dense check, not assumed): a change that appears
and reverts entirely between two coarse samples is invisible to step 1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import cv2
import numpy as np

from .layout import Layout, apply_redactions, outlined_text_mask, public_crops, presence_map
from .media import FrameRef

CHANGES_STAGE_VERSION = "1"


@dataclass
class SamplingConfig:
    coarse_step_frames: int = 6
    guard_period_s: float = 2.0
    diff_pixel_threshold: int = 40
    diff_fraction_threshold: float = 0.02
    thumb_scale: float = 0.25
    reservoir_size: int = 8
    min_ocr_frames: int = 2

    @classmethod
    def from_dict(cls, d: dict) -> "SamplingConfig":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Sample:
    frame_index: int
    time: float
    crop: np.ndarray | None


@dataclass
class Segment:
    region_id: str
    start_index: int
    start_time: float
    present: bool
    end_index: int = -1
    end_time: float = -1.0
    samples: list[Sample] = field(default_factory=list)
    guards: list[Sample] = field(default_factory=list)
    frames_sampled: int = 0
    last_guard_time: float = -1e9
    stride: int = 1
    present_samples: int = 0

    @property
    def n_frames(self) -> int:
        return self.end_index - self.start_index

    @property
    def duration(self) -> float:
        return self.end_time - self.start_time

    def representative(self) -> Sample | None:
        with_crop = [s for s in self.samples if s.crop is not None]
        if len(with_crop) == 1:
            return with_crop[0]
        if not with_crop:
            return None
        # Skip the entry frame when we can: it is the frame where the change was
        # detected and is the most likely to be mid-fade.
        pool = with_crop[1:] if len(with_crop) >= 3 else with_crop
        mid = (self.start_time + self.end_time) / 2
        return min(pool, key=lambda s: abs(s.time - mid))


@dataclass
class ScanStats:
    frames_seen: int = 0
    coarse_samples: int = 0
    refine_windows: int = 0
    frames_converted: int = 0
    first_time: float | None = None
    last_time: float | None = None

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def _thumb(crop: np.ndarray, scale: float) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    if scale >= 1.0:
        return gray
    h, w = gray.shape
    return cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


class _Sig:
    __slots__ = ("present", "thumb", "crop")

    def __init__(self, present: bool, thumb: np.ndarray | None, crop: np.ndarray | None):
        self.present, self.thumb, self.crop = present, thumb, crop


def scan(
    frames: Iterable[FrameRef], layout: Layout, cfg: SamplingConfig, fps: float
) -> tuple[dict[str, list[Segment]], ScanStats]:
    regions = [r.id for r in layout.public_regions()]
    stats = ScanStats()
    done: dict[str, list[Segment]] = {rid: [] for rid in regions}
    cur: dict[str, Segment | None] = {rid: None for rid in regions}
    last: dict[str, _Sig] = {}
    ref: dict[str, _Sig] = {}
    analyzed: dict[int, dict[str, _Sig]] = {}
    converted: set[int] = set()
    frame_dt = 1.0 / fps

    def analyze(fr: FrameRef) -> dict[str, _Sig]:
        if fr.index in analyzed:
            return analyzed[fr.index]
        raw = public_crops(fr.bgr(), layout, redact=False)
        converted.add(fr.index)
        # Presence must see the untouched overlay; everything after it sees the
        # redacted copy, so answer-bearing pixels never reach OCR or a saved crop.
        pres = presence_map(raw, layout)
        crops = apply_redactions(raw, layout)
        out = {}
        for rid in regions:
            if pres[rid]:
                reg = layout.region(rid)
                scale = (reg.diff or {}).get("thumb_scale", cfg.thumb_scale)
                if (reg.diff or {}).get("signal") == "outlined_text_mask":
                    # Camera motion behind bar-less subtitles must not look like a text change.
                    src = cv2.cvtColor(outlined_text_mask(crops[rid], reg.presence), cv2.COLOR_GRAY2BGR)
                    out[rid] = _Sig(True, _thumb(src, scale), crops[rid])
                else:
                    out[rid] = _Sig(True, _thumb(crops[rid], scale), crops[rid])
            else:
                out[rid] = _Sig(False, None, None)
        analyzed[fr.index] = out
        return out

    thresholds = {
        rid: (
            (layout.region(rid).diff or {}).get("pixel_threshold", cfg.diff_pixel_threshold),
            (layout.region(rid).diff or {}).get("fraction_threshold", cfg.diff_fraction_threshold),
        )
        for rid in regions
    }

    def differs(a: _Sig, b: _Sig, rid: str) -> bool:
        if a.present != b.present:
            return True
        if not a.present:
            return False
        px, frac = thresholds[rid]
        d = cv2.absdiff(a.thumb, b.thumb)
        return float((d > px).mean()) > frac

    def open_segment(rid: str, fr: FrameRef, sig: _Sig) -> None:
        seg = Segment(rid, fr.index, fr.time, sig.present)
        cur[rid] = seg
        ref[rid] = sig
        add_sample(rid, fr, sig, force=True)

    def close_segment(rid: str, end_index: int, end_time: float) -> None:
        seg = cur[rid]
        seg.end_index, seg.end_time = end_index, end_time
        # Keep only what OCR will read; holding every reservoir crop of every
        # closed segment exhausts memory on long intervals.
        rep = seg.representative()
        seg.samples = [rep] if rep is not None else []
        done[rid].append(seg)
        cur[rid] = None

    def add_sample(rid: str, fr: FrameRef, sig: _Sig, force: bool = False) -> None:
        seg = cur[rid]
        seg.frames_sampled += 1
        if not sig.present:
            return
        # Uniform reservoir: keep every `stride`-th present sample and double the
        # stride when full, so the kept samples stay evenly spread over the segment.
        if seg.present_samples % seg.stride == 0:
            seg.samples.append(Sample(fr.index, fr.time, sig.crop))
            if len(seg.samples) > cfg.reservoir_size:
                seg.samples = seg.samples[::2]
                seg.stride *= 2
        seg.present_samples += 1
        period = layout.region(rid).guard_period_s or cfg.guard_period_s
        if not force and fr.time - seg.last_guard_time >= period:
            seg.guards.append(Sample(fr.index, fr.time, sig.crop))
            seg.last_guard_time = fr.time
        elif force:
            seg.last_guard_time = fr.time

    def process_sample(fr: FrameRef, ring: list[FrameRef]) -> None:
        stats.coarse_samples += 1
        sig_s = analyze(fr)
        for rid in regions:
            if cur[rid] is None:
                open_segment(rid, fr, sig_s[rid])
                last[rid] = sig_s[rid]
                continue
            if not differs(sig_s[rid], last[rid], rid) and not differs(sig_s[rid], ref[rid], rid):
                add_sample(rid, fr, sig_s[rid])
                last[rid] = sig_s[rid]
                continue
            stats.refine_windows += 1
            opened_at_sample = False
            for c in ring + [fr]:
                sig_c = analyze(c)[rid]
                if differs(sig_c, last[rid], rid) or differs(sig_c, ref[rid], rid):
                    close_segment(rid, c.index, c.time)
                    open_segment(rid, c, sig_c)
                    opened_at_sample = c is fr
                last[rid] = sig_c
            if not opened_at_sample:
                add_sample(rid, fr, sig_s[rid])

    ring: list[FrameRef] = []
    k = max(1, cfg.coarse_step_frames)
    first_index = None
    last_fr: FrameRef | None = None
    for fr in frames:
        stats.frames_seen += 1
        if stats.first_time is None:
            stats.first_time = fr.time
        stats.last_time = fr.time
        last_fr = fr
        if first_index is None:
            first_index = fr.index
        # Count frames, not frame indices: indices derived from timestamps can
        # skip values, and a modulo test would then let the ring grow unbounded.
        if stats.frames_seen == 1 or len(ring) >= k - 1:
            process_sample(fr, ring)
            ring = []
            analyzed.clear()
        else:
            ring.append(fr)
    if last_fr is not None and ring:
        # Flush: the tail after the last coarse sample still gets refined.
        tail = ring[-1]
        process_sample(tail, ring[:-1])
    if last_fr is not None:
        end_index = last_fr.index + 1
        end_time = last_fr.time + frame_dt
        for rid in regions:
            if cur[rid] is not None:
                close_segment(rid, end_index, end_time)
    stats.frames_converted = len(converted)
    return done, stats

