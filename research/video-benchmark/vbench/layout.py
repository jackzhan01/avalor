"""Region layout: the allowlist that decides which pixels public extraction may see.

The public crop functions take a single region, never a frame-level view, so
nothing downstream of them can accidentally read roster or camera pixels.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .util import read_json, sha256_json
from .validate import ValidationFailed, schema_errors


@dataclass(frozen=True)
class Region:
    id: str
    kind: str
    visibility: str
    rect: tuple[int, int, int, int]
    masks: tuple[tuple[int, int, int, int], ...] = ()
    presence: dict | None = None
    guard_period_s: float | None = None
    diff: dict | None = None
    ocr_mode: str | None = None
    redact: dict | None = None
    parser: str | None = None
    cells: dict | None = None

    @property
    def is_public(self) -> bool:
        return self.visibility == "public"


@dataclass(frozen=True)
class Layout:
    layout_id: str
    frame_size: tuple[int, int]
    regions: tuple[Region, ...]
    doc: dict = field(repr=False, compare=False, hash=False, default_factory=dict)

    def region(self, rid: str) -> Region:
        for r in self.regions:
            if r.id == rid:
                return r
        raise KeyError(rid)

    def public_regions(self) -> list[Region]:
        return [r for r in self.regions if r.is_public]

    def regions_of_kind(self, kind: str, visibility: str) -> list[Region]:
        return [r for r in self.regions if r.kind == kind and r.visibility == visibility]

    def region_config_sha(self, rid: str) -> str:
        r = self.region(rid)
        extra = [r.ocr_mode] if r.ocr_mode else []  # absent key keeps v1 hashes unchanged
        if r.redact:
            extra.append(r.redact)
        if r.cells:
            # Recalibrating the vote cells changes what the board reads out of
            # identical pixels, so a cached crop must not be reused across it.
            extra.append(r.cells)
        return sha256_json([r.rect, r.masks, r.presence, r.kind, r.visibility, r.diff] + extra)


def _intersect(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return (x0, y0, x1 - x0, y1 - y0) if x1 > x0 and y1 > y0 else None


def layout_errors(doc: dict) -> list[str]:
    errs = schema_errors("layout", doc)
    if errs:
        return errs
    w, h = doc["frame_size"]
    ids = [r["id"] for r in doc["regions"]]
    if len(set(ids)) != len(ids):
        errs.append("duplicate region ids")
    for r in doc["regions"]:
        x, y, rw, rh = r["rect"]
        if rw <= 0 or rh <= 0 or x + rw > w or y + rh > h:
            errs.append(f"region {r['id']} rect outside frame")
    # A public rect overlapping a non-public rect would hand answer-bearing
    # pixels to public extraction unless the overlap is masked out.
    for pub in (r for r in doc["regions"] if r["visibility"] == "public"):
        masks = pub.get("masks", [])
        for other in (r for r in doc["regions"] if r["visibility"] != "public"):
            inter = _intersect(pub["rect"], other["rect"])
            if inter is None:
                continue
            ix, iy, iw, ih = inter
            covered = np.zeros((ih, iw), bool)
            for m in masks:
                mi = _intersect(inter, m)
                if mi:
                    covered[mi[1] - iy : mi[1] - iy + mi[3], mi[0] - ix : mi[0] - ix + mi[2]] = True
            if not covered.all():
                errs.append(f"public region {pub['id']} overlaps {other['visibility']} region {other['id']} without a mask")
    return errs


def load_layout(path: str | Path) -> Layout:
    doc = read_json(path)
    return layout_from_doc(doc)


def layout_from_doc(doc: dict) -> Layout:
    errs = layout_errors(doc)
    if errs:
        raise ValidationFailed(errs)
    regions = tuple(
        Region(
            id=r["id"],
            kind=r["kind"],
            visibility=r["visibility"],
            rect=tuple(r["rect"]),
            masks=tuple(tuple(m) for m in r.get("masks", [])),
            presence=r.get("presence"),
            guard_period_s=r.get("guard_period_s"),
            diff=r.get("diff"),
            ocr_mode=r.get("ocr_mode"),
            redact=r.get("redact"),
            parser=r.get("parser"),
            cells=r.get("cells"),
        )
        for r in doc["regions"]
    )
    return Layout(doc["layout_id"], tuple(doc["frame_size"]), regions, doc)


def keep_first_ink_run(crop_bgr: np.ndarray, cfg: dict) -> np.ndarray:
    """Blank everything after the first run of dark ink.

    For a label box whose text is centred (`<seat>号 <nickname> [<role>]`), a
    fixed sub-rectangle cannot isolate the seat: the seat token slides with the
    total text width. The seat is always the first token, so keeping only the
    first ink run drops the nickname and — in teaching edits that print the
    protagonist's role in the same box — the role, before any consumer, cache
    key or saved crop sees it. The crop keeps its shape, so diffing still works
    and now fires on seat changes rather than on nickname pixels.
    """
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    ink = (gray < cfg.get("ink_v_max", 120)).sum(axis=0) > 0
    gap = cfg.get("gap_px", 8)
    max_w = cfg.get("max_run_px", crop_bgr.shape[1])
    cols = np.flatnonzero(ink)
    out = np.zeros_like(crop_bgr)
    if cols.size == 0:
        return out
    start = int(cols[0])
    end = start
    for c in cols[1:]:
        if c - end > gap:
            break
        end = int(c)
    end = min(end, start + max_w)
    pad = cfg.get("pad_px", 4)
    lo, hi = max(0, start - pad), min(crop_bgr.shape[1], end + 1 + pad)
    out[:, lo:hi] = crop_bgr[:, lo:hi]
    return out


REDACTORS = {"keep_first_ink_run": keep_first_ink_run}


def crop_region(frame_bgr: np.ndarray, region: Region) -> np.ndarray:
    """Copy one region out of a frame, blank its masks, apply its redaction.

    Returns a fresh array: nothing downstream holds a view into the frame.
    """
    x, y, w, h = region.rect
    if frame_bgr.shape[0] < y + h or frame_bgr.shape[1] < x + w:
        raise ValueError(f"frame {frame_bgr.shape} smaller than region {region.id} {region.rect}")
    crop = np.array(frame_bgr[y : y + h, x : x + w], copy=True)
    for mx, my, mw, mh in region.masks:
        inter = _intersect(region.rect, (mx, my, mw, mh))
        if inter:
            ix, iy, iw, ih = inter
            crop[iy - y : iy - y + ih, ix - x : ix - x + iw] = 0
    return crop


def apply_redactions(crops: dict[str, np.ndarray], layout: Layout) -> dict[str, np.ndarray]:
    """Drop answer-bearing pixels a region's rect cannot avoid enclosing.

    Applied after the presence gate, which must see the untouched overlay, and
    before anything else: OCR, diffing, cache keys and saved crops all work on
    the redacted copy.
    """
    out = {}
    for rid, crop in crops.items():
        r = layout.region(rid)
        out[rid] = REDACTORS[r.redact["mode"]](crop, r.redact) if r.redact else crop
    return out


def public_crops(frame_bgr: np.ndarray, layout: Layout, redact: bool = True) -> dict[str, np.ndarray]:
    raw = {r.id: crop_region(frame_bgr, r) for r in layout.public_regions()}
    return apply_redactions(raw, layout) if redact else raw


def outlined_text_mask(crop_bgr: np.ndarray, presence: dict) -> np.ndarray:
    """Near-white pixels that touch a dark outline: bar-less burned-in subtitles.

    Calibrated on the pilot source: with no yellow bar, plain subtitle frames
    score 0.047-0.14 and camera-only frames <= 0.001 (white tables have no
    black outline).
    """
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    lo = np.array(presence["hsv_lo"], np.uint8)
    hi = np.array(presence["hsv_hi"], np.uint8)
    white = cv2.inRange(hsv, lo, hi) > 0
    black = hsv[:, :, 2] < presence.get("black_v_max", 60)
    k = presence.get("dilate_px", 5)
    near_black = cv2.dilate(black.astype(np.uint8), np.ones((k, k), np.uint8)) > 0
    return (white & near_black).astype(np.uint8) * 255


def presence_fraction(crop_bgr: np.ndarray, region: Region) -> float | None:
    """Fraction of overlay-colored pixels; None when the region has no gate."""
    if not region.presence:
        return None
    if region.presence.get("method") == "outlined_text":
        return float(outlined_text_mask(crop_bgr, region.presence).mean() / 255.0)
    band = region.presence.get("edge_band_px")
    if band:
        # Overlay text never reaches the top/bottom edge; camera content does.
        sample = np.vstack([crop_bgr[:band], crop_bgr[-band:]])
    else:
        sample = crop_bgr
    hsv = cv2.cvtColor(sample, cv2.COLOR_BGR2HSV)
    lo = np.array(region.presence["hsv_lo"], np.uint8)
    hi = np.array(region.presence["hsv_hi"], np.uint8)
    return float(cv2.inRange(hsv, lo, hi).mean() / 255.0)


def presence_map(crops: dict[str, np.ndarray], layout: Layout) -> dict[str, bool]:
    """Overlay presence for a set of public crops from the same frame."""
    own = {}
    for rid, crop in crops.items():
        r = layout.region(rid)
        frac = presence_fraction(crop, r)
        own[rid] = True if frac is None else frac >= r.presence["min_fraction"]
    out = {}
    for rid, ok in own.items():
        pres = layout.region(rid).presence or {}
        req = pres.get("requires")
        any_of = pres.get("requires_any")
        absent = pres.get("requires_absent")
        need = own.get(req, False) if req else True
        if any_of:
            # The label box also appears with bar-less subtitles; requiring the
            # yellow bar alone would drop attribution for those captions.
            need = need and any(own.get(x, False) for x in any_of)
        out[rid] = ok and need and (not own.get(absent, False) if absent else True)
    return out


def draw_overlay(frame_bgr: np.ndarray, layout: Layout) -> np.ndarray:
    """Authoring-only visualization. Output is a full frame: private artifact."""
    out = frame_bgr.copy()
    colors = {"public": (0, 200, 0), "private": (0, 0, 255), "excluded": (160, 160, 160)}
    for r in layout.regions:
        x, y, w, h = r.rect
        cv2.rectangle(out, (x, y), (x + w - 1, y + h - 1), colors[r.visibility], 3)
        cv2.putText(out, f"{r.id}:{r.visibility}", (x + 4, y + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, colors[r.visibility], 2)
        for mx, my, mw, mh in r.masks:
            cv2.rectangle(out, (mx, my), (mx + mw - 1, my + mh - 1), (255, 0, 255), 2)
    return out
