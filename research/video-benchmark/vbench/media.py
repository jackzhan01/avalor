"""Video/audio access through PyAV (bundled FFmpeg libraries; no system ffmpeg needed)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

import numpy as np


@dataclass
class FrameRef:
    """A decoded frame whose BGR conversion is deferred until someone needs pixels.

    Conversion (not decoding) dominates per-frame cost, so the coarse sampler
    only converts every k-th frame and refinement converts buffered frames on demand.
    """

    index: int
    time: float
    _convert: Callable[[], np.ndarray] = field(repr=False)
    _bgr: np.ndarray | None = field(default=None, repr=False)

    def bgr(self) -> np.ndarray:
        if self._bgr is None:
            self._bgr = self._convert()
        return self._bgr

    @property
    def converted(self) -> bool:
        return self._bgr is not None


class ConversionCounter:
    def __init__(self) -> None:
        self.decoded = 0
        self.converted = 0
        self.decode_errors: list[float | None] = []


def probe(path: str | Path) -> dict:
    import av

    with av.open(str(path)) as c:
        out = {"container_duration_s": c.duration / 1e6 if c.duration else None, "streams": []}
        for s in c.streams:
            info = {
                "index": s.index,
                "type": s.type,
                "codec": s.codec_context.name,
                "time_base": str(s.time_base),
                "duration_s": float(s.duration * s.time_base) if s.duration else None,
            }
            if s.type == "video":
                info.update(width=s.width, height=s.height, average_rate=float(s.average_rate or 0))
            elif s.type == "audio":
                info.update(sample_rate=s.rate, channels=s.channels)
            out["streams"].append(info)
        return out


def video_fps(path: str | Path) -> float:
    import av

    with av.open(str(path)) as c:
        return float(c.streams.video[0].average_rate)


def iter_video_frames(
    path: str | Path, start: float, end: float, counter: ConversionCounter | None = None
) -> Iterator[FrameRef]:
    import av

    counter = counter or ConversionCounter()
    container = av.open(str(path))
    try:
        vs = container.streams.video[0]
        vs.thread_type = "AUTO"
        fps = float(vs.average_rate)
        tb = vs.time_base
        if start > 0:
            container.seek(int(start / tb), stream=vs, backward=True, any_frame=False)
        base = 0
        for packet in container.demux(vs):
            try:
                decoded = packet.decode()
            except av.error.InvalidDataError:
                # Corrupt packets are counted, not hidden: stats report them and
                # the affected frames simply never become samples.
                counter.decode_errors.append(float(packet.pts * tb) if packet.pts is not None else None)
                continue
            for frame in decoded:
                if frame.pts is None:
                    continue
                t = float(frame.pts * tb)
                if t + 1e-6 < start:
                    continue
                if t >= end:
                    return
                # Indices count decoded frames from the interval's first frame.
                # Rounding timestamps to indices collides where pts drift off the
                # 1/fps grid (seen after ~358 s in the pilot source).
                if counter.decoded == 0:
                    base = int(round(t * fps))
                idx = base + counter.decoded
                counter.decoded += 1

                def convert(f=frame):
                    counter.converted += 1
                    return f.to_ndarray(format="bgr24")

                yield FrameRef(idx, t, convert)
    finally:
        container.close()


def grab_frames(path: str | Path, times: list[float]) -> list[tuple[float, np.ndarray]]:
    """Seek-and-decode single frames (authoring inspection, private roster reads)."""
    import av

    out = []
    with av.open(str(path)) as c:
        vs = c.streams.video[0]
        tb = vs.time_base
        for want in sorted(times):
            c.seek(int(want / tb), stream=vs, backward=True)
            for f in c.decode(vs):
                t = float(f.pts * tb)
                if t + 1e-6 >= want:
                    out.append((t, f.to_ndarray(format="bgr24")))
                    break
    return out


def load_audio_mono16k(path: str | Path, start: float, end: float) -> np.ndarray:
    """Decode [start, end) of the first audio stream to 16 kHz mono float32."""
    import av

    sr = 16000
    chunks = []
    with av.open(str(path)) as c:
        a = c.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
        if start > 0:
            c.seek(int(start * av.time_base), backward=True)
        for frame in c.decode(a):
            if frame.pts is None:
                continue
            t = float(frame.pts * a.time_base)
            if t >= end:
                break
            for rf in resampler.resample(frame):
                arr = rf.to_ndarray().reshape(-1)
                rt = float(rf.pts * rf.time_base) if rf.pts is not None else t
                chunks.append((rt, arr))
        for rf in resampler.resample(None):
            chunks.append((float(rf.pts * rf.time_base) if rf.pts is not None else end, rf.to_ndarray().reshape(-1)))
    if not chunks:
        return np.zeros(0, np.float32)
    t0 = chunks[0][0]
    audio = np.concatenate([c for _, c in chunks]).astype(np.float32)
    # Trim to the exact window using the first chunk's timestamp as origin.
    s = max(0, int(round((start - t0) * sr)))
    e = max(s, int(round((end - t0) * sr)))
    return audio[s:e]
