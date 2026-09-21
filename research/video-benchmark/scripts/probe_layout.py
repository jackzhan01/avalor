"""Measure a new source's overlay geometry from its own pixels.

Nothing here assumes the previous game's layout. It samples frames across the
whole upload and reports, per frame, where the yellow subtitle bar, the white
speaker-label box, the dark board panel and the roster panel actually are, plus
whether bar-less outlined subtitles occur. The consensus rectangles it prints
are a *starting point for a human to check against the dumped crops*, not an
automatically accepted layout.

    python scripts/probe_layout.py <video> [--n 40] [--out DIR]

Full frames are answer-bearing (the roster is on screen), so frame dumps go to
the private authoring directory only.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.media import grab_frames, probe  # noqa: E402
from vbench.util import write_bytes, write_json  # noqa: E402

YELLOW_LO, YELLOW_HI = (18, 90, 170), (38, 255, 255)
WHITE_LO, WHITE_HI = (0, 0, 200), (180, 40, 255)


def _boxes(mask: np.ndarray, min_area: int) -> list[tuple[int, int, int, int]]:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a >= min_area:
            out.append((int(x), int(y), int(w), int(h)))
    return sorted(out, key=lambda b: -b[2] * b[3])


def _hsv_mask(frame, lo, hi):
    return cv2.inRange(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV), np.array(lo, np.uint8), np.array(hi, np.uint8))


def outlined_text_fraction(crop: np.ndarray) -> float:
    """White pixels adjacent to a dark outline — the bar-less subtitle signature."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, np.array((0, 0, 225), np.uint8), np.array((180, 40, 255), np.uint8)) > 0
    near_black = cv2.dilate((hsv[:, :, 2] < 60).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return float((white & near_black).mean())


def probe_frame(frame: np.ndarray) -> dict:
    h, w = frame.shape[:2]
    lower = frame[int(h * 0.75):]           # subtitle band
    right = frame[:, int(w * 0.72):]        # board / roster column

    off = int(h * 0.75)
    xoff = int(w * 0.72)
    bar = _boxes(_hsv_mask(lower, YELLOW_LO, YELLOW_HI) > 0, min_area=w * 8)
    dark = _boxes((cv2.cvtColor(right, cv2.COLOR_BGR2HSV)[:, :, 2] < 60).astype(np.uint8), min_area=20000)

    # The label box is searched only inside the bar's own rows and left of it.
    # Over the whole lower band it merges with the (bright) camera feed into one
    # component, which is why an unrestricted search finds nothing useful.
    white = []
    if bar:
        bx, by, bw, bh = bar[0]
        strip = lower[by:by + bh, :bx]
        for b in _boxes(_hsv_mask(strip, WHITE_LO, WHITE_HI) > 0, min_area=2000):
            white.append((b[0], b[1] + by, b[2], b[3]))
    out = {
        "yellow_bar": [bar[0][0], bar[0][1] + off, bar[0][2], bar[0][3]] if bar else None,
        "white_boxes_in_band": [[b[0], b[1] + off, b[2], b[3]] for b in white[:3]],
        "dark_panels_right": [[b[0] + xoff, b[1], b[2], b[3]] for b in dark[:3]],
    }
    # Bar-less outlined text: measured on the subtitle band when no bar is present.
    out["band_outlined_fraction"] = round(outlined_text_fraction(frame[int(h * 0.83):int(h * 0.92)]), 4)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    info = probe(args.video)
    dur = info["container_duration_s"]
    times = [round(dur * (i + 0.5) / args.n, 3) for i in range(args.n)]
    out_dir = args.out or (args.video.parent.parent.parent / "runs" / "_layout_probe" / args.video.stem)

    rows = []
    bars, labels, panels = Counter(), Counter(), Counter()
    for t, frame in grab_frames(args.video, times):
        r = probe_frame(frame)
        r["time"] = t
        r["frame_size"] = [frame.shape[1], frame.shape[0]]
        rows.append(r)
        if r["yellow_bar"]:
            bars[tuple(r["yellow_bar"])] += 1
        for b in r["white_boxes_in_band"]:
            labels[tuple(b)] += 1
        for b in r["dark_panels_right"]:
            panels[tuple(b)] += 1
        # Private: full frames show the roster.
        ok, buf = cv2.imencode(".jpg", cv2.resize(frame, (960, 540)))
        write_bytes(out_dir / "private_frames" / f"frame_{t:08.3f}.jpg", buf.tobytes())

    def consensus(counter, k=6):
        return [{"rect": list(r), "frames": n} for r, n in counter.most_common(k)]

    summary = {
        "video": str(args.video), "probe": info, "sampled_times": times,
        "frame_sizes": sorted({tuple(r["frame_size"]) for r in rows}),
        "frames_with_yellow_bar": sum(1 for r in rows if r["yellow_bar"]),
        "frames_without_bar_but_outlined_text": sum(
            1 for r in rows if not r["yellow_bar"] and r["band_outlined_fraction"] >= 0.01),
        "outlined_fraction_when_bar_present": sorted(
            r["band_outlined_fraction"] for r in rows if r["yellow_bar"])[:5],
        "outlined_fraction_when_no_bar": sorted(
            (r["band_outlined_fraction"] for r in rows if not r["yellow_bar"]), reverse=True)[:10],
        "yellow_bar_candidates": consensus(bars),
        "white_box_candidates": consensus(labels),
        "right_dark_panel_candidates": consensus(panels),
        "per_frame": rows,
    }
    write_json(out_dir / "layout_probe.json", summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "per_frame"}, ensure_ascii=False, indent=2))
    print(f"\n私有整帧（含观众名单）写到 {out_dir / 'private_frames'}，不要放进公开产物。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
