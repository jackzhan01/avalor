"""Parser for the online client's history panel.

A different surface from the offline round-table board (`board.py`): rows read
`<n>号队长提名 → a·b·c` with a right-aligned `否决组队 x:y` / `通过组队 x:y` /
`自动通过` / `投票中 n/10`, the per-seat votes are *filled* chips rather than
coloured digits, and the mission result is a `任务投票: 成功 m · 失败 n` line.

It deliberately produces the same `missions` structure `board.py` does, so the
snapshot record, the event diffing and every downstream contract are reused
unchanged. Only the reading of pixels and text is new.

Answer-bearing rows (the Lady of the Lake result, the end-of-game banner naming
the assassin and the winner) are recognised and dropped here rather than being
turned into public events: this panel keeps printing them after the game, and a
run whose interval reaches them must not silently gain the answers.
"""

from __future__ import annotations

import re

import cv2
import numpy as np

from .board import _fit_cells, _lines

CLIENT_LOG_STAGE_VERSION = "1"

HEADER_RE = re.compile(r"第\s*(\d+)\s*轮.*?需\s*(\d+)\s*人")
LEADER_RE = re.compile(r"(\d{1,2})\s*号队长提名")
TEAM_RE = re.compile(r"提名\s*[→\-—–>＞]*\s*([0-9\s·.、,，]+)")
TALLY_RE = re.compile(r"(\d+)\s*[:：]\s*(\d+)")
# Counts are single digits (a team is at most 5). `\d+` would swallow the
# leading digit of the member chips that follow on the same visual line
# ("失败 0" + "6号 ✓" -> 06).
MISSION_VOTE_RE = re.compile(r"任务投票\s*[:：]?\s*成功\s*(\d)\s*[·.・,，]?\s*失败\s*(\d)")
MISSION_BADGE_RE = re.compile(r"任务\s*(成功|失败)\s*(\d)\s*[:：]\s*(\d)")

# Rows that state the answer. Never events; recorded as warnings so a reviewer
# can see the run reached them.
ANSWER_ROWS = ("湖中仙女", "湖中女神", "阵营获胜", "刺杀", "匕首", "MVP")

STRIP_DY = 33.0          # chip row sits this far under its proposal row
DEFAULT_SEAT1_X = 36.5   # measured on BV12beJ69E8W at 1920x1080
DEFAULT_CELL_DX = 38.5


def classify_chip(crop_bgr: np.ndarray, cx: float, cy: float) -> dict:
    """Vote colour of a filled chip.

    Measured on this client: reject fill H≈6 S≈195 V≈170, approve fill H≈64
    S≈118 V≈166, not-voted chips are white (S<60, V>230). The digit printed on
    a filled chip is white, so the *fill* is sampled, not the ink.
    """
    h, w = crop_bgr.shape[:2]
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
    x0, x1 = int(max(0, cx - 9)), int(min(w, cx + 10))
    y0, y1 = int(max(0, cy - 9)), int(min(h, cy + 10))
    win = hsv[y0:y1, x0:x1].reshape(-1, 3)
    if len(win) < 20:
        return {"color": "unclear", "outlined": None, "hue": None, "saturation": None}
    hue = float(np.median(win[:, 0]))
    sat = float(np.median(win[:, 1]))
    val = float(np.median(win[:, 2]))
    if sat < 60 and val > 225:
        color = "none"           # white chip: this seat has not voted (or no vote was taken)
    elif 35 <= hue <= 90 and sat > 70:
        color = "approve"
    elif (hue <= 22 or hue >= 165) and sat > 90:
        color = "reject"
    else:
        color = "unclear"
    # Team membership is printed in the row text; the gold outline is a weak
    # second reading only, so it stays advisory.
    ring = hsv[max(0, y0 - 4):y0 + 2, x0:x1].reshape(-1, 3)
    outlined = None
    if len(ring):
        gold = (ring[:, 0] >= 12) & (ring[:, 0] <= 34) & (ring[:, 1] > 50) & (ring[:, 2] > 90)
        outlined = bool(gold.mean() > 0.2)
    return {"color": color, "outlined": outlined, "hue": hue, "saturation": sat}


def _center_y(line) -> float:
    return float(np.mean([np.mean([p[1] for p in b["box"]]) for b in line]))


def parse_client_log(boxes: list[dict], crop_bgr: np.ndarray, player_count: int) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    lines = _lines(boxes)
    missions: list[dict] = []
    current: dict | None = None
    row_order = 0

    for i, line in enumerate(lines):
        text = "".join(b["text"] for b in line)

        hit = next((w for w in ANSWER_ROWS if w in text), None)
        if hit:
            # The panel states the answer here. Do not parse it into anything.
            warnings.append(f"answer-bearing row ignored ({hit})")
            continue

        hm = HEADER_RE.search(text)
        if hm:
            current = {"mission": int(hm.group(1)), "team_size": int(hm.group(2)), "proposals": [], "result": None}
            missions.append(current)
            bm = MISSION_BADGE_RE.search(text)
            if bm:
                current["result"] = {
                    "result": {"成功": "success", "失败": "fail"}[bm.group(1)],
                    "card_texts": ["成功"] * int(bm.group(2)) + ["失败"] * int(bm.group(3)),
                    "raw_text": text,
                }
            continue

        lm = LEADER_RE.search(text)
        if lm:
            if current is None:
                warnings.append(f"proposal row before any mission header: {text}")
                continue
            row_order += 1
            tm = TEAM_RE.search(text)
            team = [int(x) for x in re.findall(r"\d{1,2}", tm.group(1))] if tm else []
            if not team or len(set(team)) != len(team) or any(not 1 <= s <= player_count for s in team):
                warnings.append(f"team text unparsable: {text}")
            team = sorted({s for s in team if 1 <= s <= player_count})
            tail = text[tm.end():] if tm else text
            result_text = None
            for key in ("否决组队", "通过组队", "自动通过", "投票中"):
                if key in tail:
                    result_text = key
            forced = result_text == "自动通过"
            tally_m = None if forced else TALLY_RE.search(tail)

            cy = _center_y(line) + STRIP_DY
            strip = lines[i + 1] if i + 1 < len(lines) else []
            if strip and abs(_center_y(strip) - cy) <= 12:
                x0, dx = _fit_cells(strip, player_count)
                digit_ys = [np.mean([p[1] for p in b["box"]]) for b in strip if b["text"].strip().isdigit()]
                if digit_ys:
                    cy = float(np.median(digit_ys))
            else:
                x0, dx = DEFAULT_SEAT1_X, DEFAULT_CELL_DX
                warnings.append(f"no chip row under '{text}', default cell geometry")
            cells = {str(s): classify_chip(crop_bgr, x0 + (s - 1) * dx, cy) for s in range(1, player_count + 1)}

            current["proposals"].append({
                "row_order": row_order,
                # The client prints no proposal number; position within the
                # mission is the observable index.
                "proposal_index": len(current["proposals"]) + 1,
                "proposal_limit": None,
                "leader_seat": int(lm.group(1)) if 1 <= int(lm.group(1)) <= player_count else None,
                "team_seats": team,
                "tally": [int(tally_m.group(1)), int(tally_m.group(2))] if tally_m else None,
                "result_text": {"否决组队": "否决组队", "通过组队": "通过组队"}.get(result_text),
                "forced": forced,
                "cells": cells,
                "raw_text": text,
            })
            continue

        mv = MISSION_VOTE_RE.search(text)
        if mv:
            if current is None:
                warnings.append(f"mission result before any header: {text}")
                continue
            ok, bad = int(mv.group(1)), int(mv.group(2))
            current["result"] = {
                "result": "fail" if bad else "success",
                "card_texts": ["成功"] * ok + ["失败"] * bad,
                "raw_text": text,
            }
    return missions, warnings
