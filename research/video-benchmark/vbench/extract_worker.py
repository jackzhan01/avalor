"""Run one video's reprocessing in its own process, then let the OS reclaim it.

OCR and ASR both hold large models. In a long batch those stay resident between
videos, so the peak is whatever the heaviest pair of stages happened to overlap
rather than what one video needs. A separate process per video also means a
segfault inside a native decoder ends that video, not the batch.

Invoked as `python -m vbench.extract_worker <config.json> <out.json> [--root R]`,
and it writes its result — including its own peak memory — as JSON so the parent
reads a value the child actually measured.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--root", default=None)
    args = ap.parse_args(argv)

    from .pipeline import load_config
    from .review import build_review_queue
    from .runguard import gpu_report, peak_rss_bytes
    from .source import register_source
    from .util import write_json

    result: dict = {"ok": False}
    started = time.monotonic()
    try:
        cfg = load_config(args.config)
        root = Path(args.root) if args.root else None
        source = register_source(cfg, root)
        from .pipeline import run_extract

        stats = run_extract(cfg, source, root)
        build_review_queue(cfg, source["source_id"], root)
        result = {"ok": True, "source_id": source["source_id"], "stats": stats}
    except Exception as exc:  # noqa: BLE001 — the parent decides what a failure means
        result = {"ok": False, "error_type": type(exc).__name__, "error": str(exc)[:2000],
                  "traceback": traceback.format_exc()[-4000:]}
    finally:
        result["elapsed_s"] = round(time.monotonic() - started, 2)
        result["peak_rss_bytes"] = peak_rss_bytes()
        try:
            result["gpu_after"] = gpu_report(probe=False)
        except Exception:  # noqa: BLE001
            result["gpu_after"] = None
        write_json(args.out, result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
