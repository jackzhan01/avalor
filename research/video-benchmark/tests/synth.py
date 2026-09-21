"""Synthetic video fixtures: tiny frames whose overlays encode text as bar positions.

A fake OCR engine decodes the bar back into text, so tests exercise the real
scan/segment/merge/attribution code without models, media files or network.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from vbench.media import FrameRef

W, H = 320, 180
FPS = 30.0
YELLOW = (0, 230, 250)
WHITE = (255, 255, 255)

LAYOUT = {
    "schema": "vbench.layout/1",
    "layout_id": "synthetic-v1",
    "frame_size": [W, H],
    "regions": [
        {"id": "subtitle", "kind": "caption", "visibility": "public", "rect": [80, 150, 160, 20],
         "presence": {"hsv_lo": [18, 90, 170], "hsv_hi": [38, 255, 255], "min_fraction": 0.8, "edge_band_px": 3}},
        {"id": "speaker_label", "kind": "speaker_label", "visibility": "public", "rect": [10, 150, 60, 20],
         "presence": {"hsv_lo": [0, 0, 200], "hsv_hi": [180, 40, 255], "min_fraction": 0.8, "edge_band_px": 3, "requires": "subtitle"}},
        {"id": "board", "kind": "board", "visibility": "public", "rect": [250, 10, 60, 100], "guard_period_s": 1.0},
        {"id": "roster", "kind": "roster", "visibility": "private", "rect": [250, 115, 60, 30]},
        {"id": "camera", "kind": "camera", "visibility": "excluded", "rect": [10, 10, 230, 130]},
    ],
}


@dataclass
class FrameSpec:
    caption: int | None = None      # caption code; None = no subtitle bar
    label: int | None = None        # label code; None = no label box
    jitter: bool = False            # 2x2 dot OCR misreads, below the diff threshold
    board: int = 0                  # board state code
    roster: int = 0                 # private roster pixels
    camera: int = 0                 # camera pixels


def render(spec: FrameSpec) -> np.ndarray:
    img = np.full((H, W, 3), 60, np.uint8)
    img[10:140, 10:240] = 90 + (spec.camera * 37) % 120
    img[115:145, 250:310] = (spec.roster * 53) % 255
    img[10:110, 250:310] = 20
    img[20:30, 255 + (spec.board % 5) * 10 : 263 + (spec.board % 5) * 10] = 230
    if spec.caption is not None:
        img[150:170, 80:240] = YELLOW
        x = 80 + 5 + spec.caption * 10
        img[155:165, x : x + 8] = 0
        if spec.jitter:
            img[158:160, 232:234] = 0
        if spec.label is not None:
            img[150:170, 10:70] = WHITE
            lx = 10 + 3 + spec.label * 5
            img[155:165, lx : lx + 4] = 0
    return img


def frames(specs: list[FrameSpec], start_index: int = 0) -> list[FrameRef]:
    out = []
    for i, s in enumerate(specs):
        arr = render(s)
        out.append(FrameRef(start_index + i, (start_index + i) / FPS, lambda a=arr: a))
    return out


def timeline(*runs: tuple[int, FrameSpec]) -> list[FrameSpec]:
    specs = []
    for n, s in runs:
        specs += [s] * n
    return specs


@dataclass
class DecodingOcr:
    """Reads the synthetic bar codes back into text."""

    captions: dict[int, str]
    labels: dict[int, str] = field(default_factory=dict)
    boards: dict[int, list[dict]] = field(default_factory=dict)
    jitter_suffix: str = "了"
    version: str = "decoding-ocr-1"
    name: str = "synthetic"
    calls: int = 0

    def version_key(self) -> str:
        return self.version

    def run(self, crop, mode: str) -> list[dict]:
        self.calls += 1
        h, w = crop.shape[:2]
        if mode == "page2x":
            col = np.where(crop[10:20].max(axis=2).max(axis=0) > 200)[0]
            code = int(col[0] // 10) if len(col) else 0
            return [dict(b) for b in self.boards.get(code, [])]
        dark = crop.max(axis=2) < 40
        cols = np.where(dark[5:15].any(axis=0))[0]
        if not len(cols):
            return []
        box = [[0, 0], [w, 0], [w, h], [0, h]]
        if w == 160:
            code = int((cols[0] - 5) // 10)
            text = self.captions.get(code, "")
            if dark[8:10, 152:154].all():
                text += self.jitter_suffix
            return [{"text": text, "box": box, "score": 0.95}] if text else []
        code = int((cols[0] - 3) // 5)
        text = self.labels.get(code, "")
        return [{"text": text, "box": box, "score": 0.9}] if text else []


def write_layout(tmp: Path, doc: dict | None = None) -> Path:
    p = tmp / "layout.json"
    p.write_text(json.dumps(doc or LAYOUT), encoding="utf-8")
    return p


def pilot_cfg(layout_path: Path, **over) -> dict:
    cfg = {
        "schema": "vbench.pilot_config/1",
        "run_id": "synthetic",
        "source": {"key": "synthetic", "video_file": "synthetic.mp4", "audio_file": None, "bvid": "BV1xx411c7mD", "title": "秘密标题"},
        "layout": str(layout_path),
        "interval": {"start": 0, "end": 100, "rationale": "synthetic"},
        "sampling": {"coarse_step_frames": 6, "guard_period_s": 1.0, "diff_pixel_threshold": 40, "diff_fraction_threshold": 0.02, "thumb_scale": 1.0, "reservoir_size": 8, "min_ocr_frames": 2},
        "captions": {"merge_gap_s": 0.35, "jitter_cer": 0.25, "short_s": 0.4, "low_score": 0.8, "clean_sample_rate": 0.0},
        "ocr": {"engine": "fake"},
        "asr": {"backend": "none"},
        "rules": {
            "player_count": 10, "mission_team_sizes": [3, 4, 4, 5, 5], "proposal_limit": 3, "final_proposal_forced": True,
            "fails_required": [1, 1, 1, 2, 1], "lady_of_the_lake": None,
            "role_composition": {"merlin": 1, "percival": 1, "loyal": 4, "morgana": 1, "mordred": 1, "assassin": 1, "oberon": 1},
        },
        "split": {"group_id": "grp-synth", "split": "dev"},
        "cutoffs": [],
    }
    cfg.update(over)
    return cfg


SOURCE = {"video_sha256": "a" * 64, "audio_sha256": None, "video": None, "audio": None, "source_id": "src-aaaaaaaaaaaa", "game_id": "game-0123456789"}
