"""Verify a downloaded media file before it is used as evidence.

A file that downloaded "successfully" can still be truncated, mis-muxed, or
undecodable past some point. This walks the whole video stream, so the decode
coverage it reports is measured rather than assumed, then checks seek accuracy
at several points and compares the audio and video durations.

    python scripts/verify_media.py <video> [--audio <audio>] [--out report.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import av  # noqa: E402

from vbench.media import probe  # noqa: E402
from vbench.util import write_json  # noqa: E402


def decode_walk(path: Path) -> dict:
    """Decode every video frame; report coverage, gaps and errors."""
    container = av.open(str(path))
    stream = container.streams.video[0]
    tb = float(stream.time_base)
    n = 0
    first = last = None
    prev = None
    max_gap = 0.0
    gap_at = None
    errors: list[str] = []
    try:
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            t = frame.pts * tb
            if first is None:
                first = t
            if prev is not None:
                d = t - prev
                if d > max_gap:
                    max_gap, gap_at = d, prev
            prev = last = t
            n += 1
    except Exception as e:  # noqa: BLE001
        errors.append(f"{type(e).__name__}: {e}")
    container.close()
    return {"frames_decoded": n, "first_pts_s": first, "last_pts_s": last,
            "largest_inter_frame_gap_s": round(max_gap, 4), "largest_gap_at_s": gap_at,
            "decode_errors": errors}


def seek_check(path: Path, targets: list[float]) -> list[dict]:
    from vbench.media import grab_frames

    out = []
    got = list(grab_frames(path, targets))
    for want, (actual, frame) in zip(targets, got):
        out.append({"requested_s": want, "returned_s": round(actual, 4),
                    "delta_s": round(actual - want, 4),
                    "frame_size": [int(frame.shape[1]), int(frame.shape[0])]})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--audio", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--tolerance-s", type=float, default=1.0)
    args = ap.parse_args()

    rep: dict = {"video": str(args.video), "video_probe": probe(args.video)}
    vs = next(s for s in rep["video_probe"]["streams"] if s["type"] == "video")
    dur = rep["video_probe"]["container_duration_s"]
    rep["walk"] = decode_walk(args.video)

    fps = float(vs["average_rate"])
    expected = dur * fps
    got = rep["walk"]["frames_decoded"]
    rep["coverage"] = {
        "expected_frames_approx": round(expected),
        "decoded_frames": got,
        "decoded_fraction": round(got / expected, 4) if expected else None,
        "last_frame_vs_duration_s": round(dur - (rep["walk"]["last_pts_s"] or 0), 3),
    }

    span = rep["walk"]["last_pts_s"] or dur
    rep["seek"] = seek_check(args.video, [round(span * f, 2) for f in (0.02, 0.25, 0.5, 0.75, 0.98)])

    if args.audio and args.audio.exists():
        ap_probe = probe(args.audio)
        a = next(s for s in ap_probe["streams"] if s["type"] == "audio")
        rep["audio_probe"] = ap_probe
        rep["av_sync"] = {
            "video_duration_s": dur,
            "audio_duration_s": ap_probe["container_duration_s"],
            "difference_s": round(dur - ap_probe["container_duration_s"], 3),
            "within_tolerance": abs(dur - ap_probe["container_duration_s"]) <= args.tolerance_s,
        }

    ok = (
        not rep["walk"]["decode_errors"]
        and rep["coverage"]["decoded_fraction"] is not None
        and rep["coverage"]["decoded_fraction"] > 0.98
        and abs(rep["coverage"]["last_frame_vs_duration_s"]) <= 2.0
        and all(abs(s["delta_s"]) <= args.tolerance_s for s in rep["seek"])
        and rep.get("av_sync", {}).get("within_tolerance", True)
    )
    rep["verdict"] = "ok" if ok else "PROBLEM"
    if args.out:
        write_json(args.out, rep)
    print(json.dumps({k: v for k, v in rep.items() if k != "video_probe"}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
