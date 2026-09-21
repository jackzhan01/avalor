"""Source acquisition, local ingestion and the evaluator-side manifest.

Everything that can identify the source video (title, uploader, link, BVID,
hashes) lives here and under `evaluator/`. Agent-facing X never reads it.
"""

from __future__ import annotations

import os
import secrets
import subprocess
import sys
from pathlib import Path

from .paths import data_root, evaluator_dir
from .util import read_json, sha256_file, write_json
from .validate import require_valid

_HASH_MEMO = "hash_memo.json"


def file_sha256_memo(path: Path, root: Path | None = None) -> str:
    """sha256 of a large media file, memoized on (path, size, mtime)."""
    root = root or data_root()
    memo_path = root / "cache" / _HASH_MEMO
    memo = read_json(memo_path) if memo_path.exists() else {}
    st = path.stat()
    key = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    if key not in memo:
        memo[key] = sha256_file(path)
        write_json(memo_path, memo)
    return memo[key]


def source_id_for(video_sha: str) -> str:
    return f"src-{video_sha[:12]}"


def manifest_path(root: Path | None = None) -> Path:
    return evaluator_dir(root) / "manifest.json"


def load_manifest(root: Path | None = None) -> dict:
    p = manifest_path(root)
    if p.exists():
        return read_json(p)
    return {"schema": "vbench.evaluator_manifest/1", "games": [], "samples": []}


def save_manifest(doc: dict, root: Path | None = None) -> None:
    require_valid(doc, "evaluator_manifest")
    write_json(manifest_path(root), doc)


def register_source(cfg: dict, root: Path | None = None) -> dict:
    """Hash + probe the local media and ensure an opaque game id exists."""
    from .media import probe

    root = root or data_root()
    src = cfg["source"]
    video = root / src["video_file"]
    if not video.exists():
        raise FileNotFoundError(f"视频文件不存在：{video}（先运行 acquire，或把本地文件放到这里再 ingest）")
    audio = root / src["audio_file"] if src.get("audio_file") else None
    video_sha = file_sha256_memo(video, root)
    audio_sha = file_sha256_memo(audio, root) if audio and audio.exists() else None
    source_id = source_id_for(video_sha)
    record_path = evaluator_dir(root) / "sources" / f"{source_id}.json"
    record = read_json(record_path) if record_path.exists() else {}
    record.update({
        "source_id": source_id,
        "video_sha256": video_sha,
        "audio_sha256": audio_sha,
        "video_file": src["video_file"],
        "audio_file": src.get("audio_file"),
        "platform": src.get("platform"),
        "url": src.get("url"),
        "bvid": src.get("bvid"),
        "aid": src.get("aid"),
        "cid": src.get("cid"),
        "part": src.get("part"),
        "probe": probe(video),
        "audio_probe": probe(audio) if audio and audio.exists() else None,
    })
    write_json(record_path, record)

    manifest = load_manifest(root)
    game = next((g for g in manifest["games"] if g["source"]["source_id"] == source_id), None)
    if game is None:
        game = {
            "game_id": f"game-{secrets.token_hex(5)}",
            "group_id": cfg["split"]["group_id"],
            "split": cfg["split"]["split"],
            "source": {"source_id": source_id, "video_sha256": video_sha, "audio_sha256": audio_sha},
        }
        manifest["games"].append(game)
    elif (game["group_id"], game["split"]) != (cfg["split"]["group_id"], cfg["split"]["split"]):
        raise ValueError(
            f"{source_id} 已登记为 {game['group_id']}/{game['split']}，配置要求 "
            f"{cfg['split']['group_id']}/{cfg['split']['split']}：同一局不能跨 split"
        )
    save_manifest(manifest, root)
    return {"source_id": source_id, "video_sha256": video_sha, "audio_sha256": audio_sha, "game_id": game["game_id"], "video": video, "audio": audio, "record": record}


def acquire(cfg: dict, root: Path | None = None) -> list[Path]:
    """Download with yt-dlp (a maintained downloader); no cookies, no browser credentials.

    Signed media URLs are never written: no info json, and stdout stays in the terminal.
    """
    root = root or data_root()
    src = cfg["source"]
    formats = src.get("download_formats") or {}
    out = []
    for kind, rel in (("video", src["video_file"]), ("audio", src.get("audio_file"))):
        if not rel or kind not in formats:
            continue
        target = root / rel
        if target.exists():
            out.append(target)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-write-info-json", "--no-part", "--no-mtime",
            "-f", str(formats[kind]), "-o", str(target), src["url"],
        ]
        env = dict(os.environ)
        subprocess.run(cmd, check=True, env=env)
        out.append(target)
    return out
