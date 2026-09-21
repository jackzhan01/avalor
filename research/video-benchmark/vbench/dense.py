"""Dense check: every-frame segmentation vs. the configured coarse sampling.

Measures what low-frequency sampling misses instead of assuming coverage, and
writes public-crop strips so a human can look for captions both passes missed.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .changes import SamplingConfig, scan
from .layout import Layout, public_crops
from .media import iter_video_frames
from .util import write_bytes, write_json


def _hstack_padded(parts: list[np.ndarray]) -> np.ndarray:
    h = max(p.shape[0] for p in parts)
    return np.hstack([
        cv2.copyMakeBorder(p, (h - p.shape[0]) // 2, h - p.shape[0] - (h - p.shape[0]) // 2, 0, 0, cv2.BORDER_CONSTANT, value=(128, 128, 128))
        for p in parts
    ])


def _boundaries(segs) -> list[tuple[int, float]]:
    return [(s.start_index, s.start_time) for s in segs[1:]]


def dense_check(video: Path, layout: Layout, sampling: dict, fps: float, start: float, end: float, out_dir: Path, strip_every_frames: int = 6) -> dict:
    base = SamplingConfig.from_dict(sampling)
    dense_cfg = SamplingConfig.from_dict(dict(sampling, coarse_step_frames=1))
    coarse, cstats = scan(iter_video_frames(video, start, end), layout, base, fps)
    dense, dstats = scan(iter_video_frames(video, start, end), layout, dense_cfg, fps)
    result = {"interval": [start, end], "coarse_step_frames": base.coarse_step_frames, "regions": {}, "coarse_scan": cstats.as_dict(), "dense_scan": dstats.as_dict()}
    for r in layout.public_regions():
        cb = _boundaries(coarse[r.id])
        db = _boundaries(dense[r.id])
        c_idx = [i for i, _ in cb]
        missed = [(i, t) for i, t in db if not any(abs(i - j) <= 1 for j in c_idx)]
        extra = [(i, t) for i, t in cb if not any(abs(i - j) <= 1 for j, _ in db)]
        short_dense = [s for s in dense[r.id] if s.present and s.n_frames < base.coarse_step_frames]
        result["regions"][r.id] = {
            "dense_boundaries": len(db),
            "coarse_boundaries": len(cb),
            "dense_boundaries_missed_by_coarse": {"count": len(missed), "times": [round(t, 3) for _, t in missed[:50]]},
            "coarse_boundaries_not_in_dense": {"count": len(extra), "times": [round(t, 3) for _, t in extra[:50]]},
            "dense_present_segments_shorter_than_coarse_step": {"count": len(short_dense), "spans": [[round(s.start_time, 3), round(s.end_time, 3)] for s in short_dense[:50]]},
        }
    # Human inspection strips: subtitle + label crops every few frames (public crops only).
    rows, sheet_no = [], 0
    caption = next((r for r in layout.public_regions() if r.kind == "caption"), None)
    label = next((r for r in layout.public_regions() if r.kind == "speaker_label"), None)
    n = 0
    for fr in iter_video_frames(video, start, end):
        n += 1
        if (n - 1) % strip_every_frames:
            continue
        crops = public_crops(fr.bgr(), layout)
        parts = [crops[x.id] for x in (label, caption) if x is not None]
        row = cv2.resize(_hstack_padded(parts), None, fx=0.5, fy=0.5)
        cv2.putText(row, f"{fr.time:.2f}", (2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
        rows.append(row)
        if len(rows) == 40:
            sheet_no += 1
            ok, buf = cv2.imencode(".png", np.vstack(rows))
            write_bytes(out_dir / f"strip_{start:07.2f}_{sheet_no:03d}.png", buf.tobytes())
            rows = []
    if rows:
        sheet_no += 1
        ok, buf = cv2.imencode(".png", np.vstack(rows))
        write_bytes(out_dir / f"strip_{start:07.2f}_{sheet_no:03d}.png", buf.tobytes())
    result["strip_sheets"] = sheet_no
    result["strip_every_frames"] = strip_every_frames
    write_json(out_dir / f"dense_check_{start:07.2f}_{end:07.2f}.json", result)
    return result


def reference_sheets(video: Path, layout: Layout, sampling: dict, fps: float, start: float, end: float, out_dir: Path, rows_per_sheet: int = 30) -> dict:
    """Contact sheets for an independent reference transcription.

    Built from an every-frame scan (no coarse sampling blind spot) and showing
    only public crops plus row number and time -- never machine OCR text, so the
    reviewer transcribes from pixels rather than proof-reading the machine.
    """
    dense_cfg = SamplingConfig.from_dict(dict(sampling, coarse_step_frames=1))
    segs, stats = scan(iter_video_frames(video, start, end), layout, dense_cfg, fps)
    caption = next(r for r in layout.public_regions() if r.kind == "caption")
    label = next(r for r in layout.public_regions() if r.kind == "speaker_label")
    labels = [s for s in segs[label.id] if s.present]
    rows, index, sheet_no = [], [], 0

    def flush():
        nonlocal rows, sheet_no
        if not rows:
            return
        sheet_no += 1
        ok, buf = cv2.imencode(".png", np.vstack(rows))
        write_bytes(out_dir / f"sheet_{sheet_no:03d}.png", buf.tobytes())
        rows = []

    blank_label = np.full((label.rect[3], label.rect[2], 3), 128, np.uint8)
    for s in segs[caption.id]:
        if not s.present:
            continue
        rep = s.representative()
        if rep is None:
            continue
        mid = rep.time
        lab = next((l for l in labels if l.start_time <= mid < l.end_time), None)
        lab_crop = lab.representative().crop if lab and lab.representative() else blank_label
        row = cv2.resize(_hstack_padded([lab_crop, rep.crop]), None, fx=0.6, fy=0.6)
        pad = np.full((row.shape[0], 150, 3), 255, np.uint8)
        n = len(index) + 1
        cv2.putText(pad, f"#{n} {s.start_time:.2f}", (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
        cv2.putText(pad, f"{s.n_frames}f", (4, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
        rows.append(np.hstack([pad, row]))
        index.append({"row": n, "sheet": sheet_no + 1, "start": round(s.start_time, 4), "end": round(s.end_time, 4), "frames": s.n_frames, "rep_time": round(mid, 4)})
        if len(rows) == rows_per_sheet:
            flush()
    flush()
    write_json(out_dir / "index.json", {"interval": [start, end], "rows": index, "scan": stats.as_dict()})
    return {"rows": len(index), "sheets": sheet_no, "out_dir": str(out_dir)}
