"""OCR adapters. Engines only ever receive public region crops."""

from __future__ import annotations

import threading
from typing import Protocol

import cv2
import numpy as np

from .cache import StageCache
from .util import array_sha256

OCR_STAGE_VERSION = "1"


class OcrEngine(Protocol):
    name: str

    def version_key(self) -> str: ...

    def run(self, crop_bgr: np.ndarray, mode: str) -> list[dict]:
        """mode: 'line' (recognition only), 'page' (detect + recognize), 'page2x' (upscaled page)."""
        ...


class RapidOcrEngine:
    name = "rapidocr_onnxruntime"

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR

        self._engine = RapidOCR()
        self._lock = threading.Lock()

    def version_key(self) -> str:
        import onnxruntime
        import rapidocr_onnxruntime

        ver = getattr(rapidocr_onnxruntime, "__version__", None)
        if ver is None:
            from importlib.metadata import version

            ver = version("rapidocr_onnxruntime")
        # Bundled PP-OCRv4 det/rec + mobile cls models ship inside this wheel version.
        return f"rapidocr_onnxruntime=={ver};onnxruntime=={onnxruntime.__version__};models=bundled-PP-OCRv4"

    def run(self, crop_bgr: np.ndarray, mode: str) -> list[dict]:
        h, w = crop_bgr.shape[:2]
        with self._lock:
            if mode == "line":
                res, _ = self._engine(crop_bgr, use_det=False, use_cls=False)
                out = []
                for text, score in res or []:
                    out.append({"text": str(text), "box": [[0, 0], [w, 0], [w, h], [0, h]], "score": float(score)})
                return out
            scale = 2.0 if mode == "page2x" else 1.0
            img = crop_bgr if scale == 1.0 else cv2.resize(crop_bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            res, _ = self._engine(img, use_cls=False)
        # Box coordinates are always reported in the original crop's pixels.
        return [
            {"text": str(text), "box": [[float(x) / scale, float(y) / scale] for x, y in box], "score": float(score)}
            for box, text, score in (res or [])
        ]


class FakeOcrEngine:
    """Deterministic test engine: looks up text by crop content hash.

    Tests register what each synthetic crop "says"; unknown crops read as empty,
    which is exactly how a real engine behaves on a blank overlay.
    """

    name = "fake"

    def __init__(self, table: dict[str, list[dict]] | None = None, version: str = "fake-1"):
        self.table = table or {}
        self.version = version
        self.calls = 0

    def version_key(self) -> str:
        return self.version

    def run(self, crop_bgr: np.ndarray, mode: str) -> list[dict]:
        self.calls += 1
        return [dict(b) for b in self.table.get(array_sha256(crop_bgr), [])]


def ink_fraction(crop_bgr: np.ndarray) -> float:
    """Share of dark pixels: cheap 'is there text at all' check before OCR."""
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    return float((gray < 80).mean())


def join_boxes(boxes: list[dict]) -> str:
    # Reading order: top-to-bottom lines, then left-to-right. Exact characters,
    # no normalization — the raw string is evidence.
    def key(b):
        ys = [p[1] for p in b["box"]]
        xs = [p[0] for p in b["box"]]
        return (round((min(ys) + max(ys)) / 2 / 12), min(xs))

    return "".join(b["text"] for b in sorted(boxes, key=key))


def run_ocr_cached(
    engine: OcrEngine, cache: StageCache, crop_bgr: np.ndarray, mode: str
) -> tuple[list[dict], bool, str]:
    crop_sha = array_sha256(crop_bgr)
    key = StageCache.key("ocr", OCR_STAGE_VERSION, crop=crop_sha, engine=engine.version_key(), mode=mode)
    boxes, hit = cache.get_or_compute("ocr", key, lambda: engine.run(crop_bgr, mode))
    return boxes, hit, crop_sha


def make_engine(name: str) -> OcrEngine:
    if name == "rapidocr":
        return RapidOcrEngine()
    if name == "fake":
        return FakeOcrEngine()
    raise ValueError(f"unknown OCR engine {name}")
