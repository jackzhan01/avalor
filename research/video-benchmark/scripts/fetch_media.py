"""Fetch one media stream with bounded retries and a real no-growth watchdog.

The plain downloader can sit in an infinite retry loop against a throttled CDN
and look identical to "still working". This wrapper watches the output file: if
it stops growing for `--stall-s`, the attempt is killed and recorded as stalled
rather than waited on forever. Every attempt appends to a log so a later report
can say what was tried and what happened.

    python scripts/fetch_media.py BV1kr876AEE1 --format 30077 --suffix hevc

No cookies, no browser credentials, no access-control bypass: the same public
yt-dlp path the pipeline's `acquire` uses.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.paths import data_root  # noqa: E402
from vbench.util import write_json  # noqa: E402


def attempt(url: str, fmt: str, target: Path, *, stall_s: float, max_s: float,
            socket_timeout: int, retries: int, chunk: str) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    cmd = [sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-write-info-json", "--no-part",
           "--no-mtime", "--continue", "--newline",
           "--socket-timeout", str(socket_timeout), "--retries", str(retries),
           "--fragment-retries", str(retries), "--http-chunk-size", chunk,
           "-f", fmt, "-o", str(target), url]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    state = {"stalled": False, "timed_out": False}

    def watch():
        last_size, last_change = -1, time.monotonic()
        while proc.poll() is None:
            time.sleep(5)
            size = target.stat().st_size if target.exists() else 0
            now = time.monotonic()
            if size != last_size:
                last_size, last_change = size, now
            elif now - last_change > stall_s:
                state["stalled"] = True
                proc.kill()
                return
            if now - started > max_s:
                state["timed_out"] = True
                proc.kill()
                return

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    err = (proc.communicate()[1] or "").strip().splitlines()
    t.join(timeout=10)
    size = target.stat().st_size if target.exists() else 0
    return {
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "format": fmt, "target": str(target), "elapsed_s": round(time.monotonic() - started, 1),
        "returncode": proc.returncode, "bytes": size,
        "stalled_no_growth": state["stalled"], "hit_max_seconds": state["timed_out"],
        "stderr_tail": err[-3:],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bvid")
    ap.add_argument("--format", required=True)
    ap.add_argument("--suffix", default=None, help="separate file name, e.g. 'hevc' -> <bvid>.video.hevc.mp4")
    ap.add_argument("--stall-s", type=float, default=180.0)
    ap.add_argument("--max-s", type=float, default=2700.0)
    ap.add_argument("--socket-timeout", type=int, default=45)
    ap.add_argument("--retries", type=int, default=20)
    ap.add_argument("--chunk", default="2M")
    ap.add_argument("--expect-bytes", type=int, default=None, help="treat the file as complete at/above this size")
    args = ap.parse_args()

    root = data_root()
    name = f"{args.bvid}.video{'.' + args.suffix if args.suffix else ''}.mp4"
    target = root / "sources" / "raw" / name
    url = f"https://www.bilibili.com/video/{args.bvid}/"

    rec = attempt(url, args.format, target, stall_s=args.stall_s, max_s=args.max_s,
                  socket_timeout=args.socket_timeout, retries=args.retries, chunk=args.chunk)
    complete = rec["returncode"] == 0 and not rec["stalled_no_growth"] and not rec["hit_max_seconds"]
    if args.expect_bytes:
        complete = complete and rec["bytes"] >= args.expect_bytes
    rec["complete"] = bool(complete)

    log_path = root / "sources" / "fetch_attempts.json"
    log = json.loads(log_path.read_text(encoding="utf-8")) if log_path.exists() else []
    log.append(rec)
    write_json(log_path, log)
    print(json.dumps(rec, ensure_ascii=False, indent=2))
    return 0 if complete else 1


if __name__ == "__main__":
    raise SystemExit(main())
