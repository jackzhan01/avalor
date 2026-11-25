"""Resume a public uploader inventory without saving signed media URLs or credentials.

Enumeration and per-video metadata have separate checkpoints. A rejected request
stops this invocation; it is never treated as an empty or complete catalogue.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from yt_dlp import YoutubeDL


def save(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uid", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--seed", type=Path)
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--metadata", action="store_true")
    ap.add_argument("--delay", type=float, default=3.0)
    args = ap.parse_args()
    doc = json.loads(args.out.read_text(encoding="utf-8")) if args.out.exists() else {
        "schema": "vbench.uploader_inventory/1", "uid": args.uid,
        "enumeration_complete": False, "videos": {}, "attempts": [],
    }
    if doc["uid"] != args.uid:
        raise ValueError("Inventory belongs to a different uploader")
    if args.seed:
        raw = args.seed.read_bytes()
        seed = json.loads(raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"))
        for entry in seed["entries"]:
            doc["videos"].setdefault(entry["id"], {"id": entry["id"], "status": "metadata_pending"})
        save(args.out, doc)
    options = {"quiet": True, "no_warnings": True, "socket_timeout": 20,
               "retries": 0, "extractor_retries": 0, "skip_download": True}
    stage = "start"
    try:
        if args.discover:
            stage = "enumeration"
            with YoutubeDL(options | {"extract_flat": True}) as ydl:
                playlist = ydl.extract_info(f"https://space.bilibili.com/{args.uid}/video", download=False, process=False)
                for entry in playlist["entries"]:
                    doc["videos"].setdefault(entry["id"], {"id": entry["id"], "status": "metadata_pending"})
                    save(args.out, doc)
                doc["enumeration_complete"] = True
                doc["enumerated_at_utc"] = datetime.now(timezone.utc).isoformat()
                save(args.out, doc)
                print(f"Enumerated {len(doc['videos'])} videos", flush=True)
        if args.metadata:
            with YoutubeDL(options) as ydl:
                for bvid, entry in doc["videos"].items():
                    if entry["status"] == "metadata_ready":
                        continue
                    stage = bvid
                    info = ydl.extract_info(f"https://www.bilibili.com/video/{bvid}/", download=False)
                    if info.get("_type") == "playlist":
                        parts = list(info["entries"])
                    else:
                        parts = [info]
                    rows = []
                    for part in parts:
                        if str(part.get("uploader_id")) != args.uid:
                            raise ValueError("Video uploader differs from requested UID")
                        rows.append({k: part.get(k) for k in (
                            "id", "title", "duration", "upload_date", "uploader", "uploader_id",
                            "webpage_url", "thumbnail", "playlist_index")})
                    entry.update(status="metadata_ready", parts=rows)
                    entry["candidate_long_form"] = any((r["duration"] or 0) >= 600 for r in rows)
                    entry["player_count"] = None
                    entry["player_count_basis"] = "Requires inspection of this video's own game board"
                    save(args.out, doc)
                    print(json.dumps({"id": bvid, "parts": len(rows), "title": rows[0]["title"],
                                      "duration": rows[0]["duration"]}, ensure_ascii=False), flush=True)
                    time.sleep(max(0, args.delay))
        doc["attempts"].append({"at_utc": datetime.now(timezone.utc).isoformat(), "ok": True})
        save(args.out, doc)
        return 0
    except Exception as exc:
        # Error text may carry a media URL; only keep the stage and error class.
        doc["attempts"].append({"at_utc": datetime.now(timezone.utc).isoformat(), "ok": False,
                                "stage": stage, "error_type": type(exc).__name__})
        save(args.out, doc)
        print(f"Stopped at {stage}: {type(exc).__name__}; checkpoint retained", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
