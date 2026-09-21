"""Full decode gate bound to content hashes, not downloader exit codes or file sizes."""

from pathlib import Path

import av

from .util import read_json, sha256_file, sha256_json, write_json


def media_hashes(video: Path, audio: Path | None) -> dict:
    paths = {"video": video}
    if audio is not None:
        paths["audio"] = audio
    for path in paths.values():
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"媒体缺失或为空：{path}")
    return {kind: sha256_file(path) for kind, path in paths.items()}


def decode_stream(path: Path, kind: str) -> dict:
    with av.open(str(path)) as container:
        streams = [s for s in container.streams if s.type == kind]
        if not streams:
            raise ValueError(f"缺少 {kind} 流：{path}")
        stream = streams[0]
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else (
            container.duration / av.time_base if container.duration is not None else None)
        first = last = None
        count = 0
        max_gap = 0.0
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("媒体帧缺少时间戳")
            now = float(frame.pts * frame.time_base)
            if last is not None:
                if now < last:
                    raise ValueError("媒体时间戳倒退")
                max_gap = max(max_gap, now - last)
            first = now if first is None else first
            last = now
            count += 1
        if not count or duration is None or duration <= 0:
            raise ValueError("媒体没有可验证的完整时长")
        # Duration agreement is not proof of perceptual A/V synchronisation.
        if abs((last - first) - duration) > 2.0 or max_gap > 2.0:
            raise ValueError("媒体解码覆盖不完整或存在超过 2 秒的帧间缺口")
        return {"frames": count, "first_s": first, "last_s": last, "duration_s": duration,
                "max_gap_s": max_gap}


def verify_media(video: Path, audio: Path | None, reports: Path) -> dict:
    hashes = media_hashes(video, audio)
    key = sha256_json({"version": 1, "hashes": hashes})
    report_path = reports / f"{key}.json"
    if report_path.exists():
        report = read_json(report_path)
        if report.get("hashes") == hashes and report.get("verdict") == "ok" and report.get("version") == 1:
            return report
    streams = {"video": decode_stream(video, "video")}
    if audio is not None:
        streams["audio"] = decode_stream(audio, "audio")
        if abs(streams["video"]["duration_s"] - streams["audio"]["duration_s"]) > 1.0:
            raise ValueError("音视频时长差超过 1 秒，需人工核查")
    if media_hashes(video, audio) != hashes:
        raise ValueError("验证期间媒体发生变化")
    report = {"version": 1, "hashes": hashes, "streams": streams, "verdict": "ok",
              "perceptual_av_sync": "not_verified"}
    write_json(report_path, report)
    return report
