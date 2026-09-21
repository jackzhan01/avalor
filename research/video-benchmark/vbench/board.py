"""History-board snapshots and snapshot diffs.

The board is a *snapshot* of an operator's app, not an event stream. In the
pilot source it is updated in bulk and can run ahead of the edited narrative,
so every board-derived event starts `unanchored`: it cannot enter a cutoff
until a reviewer ties it to a public reveal in the video.
"""

from __future__ import annotations

import re

import cv2
import numpy as np

from .util import short_id

BOARD_STAGE_VERSION = "1"

HEADER_RE = re.compile(r"第\s*(\d)\s*轮任务.*?需要\s*(\d+)\s*名")
LEADER_RE = re.compile(r"(\d{1,2})\s*号队长")
TEAM_RE = re.compile(r"(?:→|->|一>|>)\s*((?:\d{1,2}\s*[·\.\-、,]\s*)*\d{1,2})")
INDEX_RE = re.compile(r"第\s*(\d)\s*/\s*(\d)\s*次组队")
TALLY_RE = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{1,2})")
MISSION_RE = re.compile(r"任务(成功|失败)")

MISSION_TEAM_RE = re.compile(r"(\d{1,2})\s*号")

# Calibrated on the 1080p pilot layout (board crop coordinates, 1x):
# seat-cell centers step ~35.6 px, strip sits ~21.5 px below its header line.
DEFAULT_CELL_DX = 35.6
DEFAULT_SEAT1_X = 35.3
STRIP_DY = 21.5

DEFAULT_CELLS = {
    "method": "digit_ink", "seat1_x": DEFAULT_SEAT1_X, "cell_dx": DEFAULT_CELL_DX, "strip_dy": STRIP_DY,
    # window and thresholds used by the cell_background method
    "half_w": 13, "half_h": 8, "bg_value_max": 110, "min_pixels": 20,
    "approve_hue": [20, 50], "reject_sat_min": 115, "warm_hue_max": 19, "warm_hue_min": 160,
}


def cell_calibration(cells: dict | None) -> dict:
    """Per-board cell geometry and colours.

    Boards differ: the offline pilot encodes a vote in the seat digit's ink,
    this uploader's client encodes it in the cell's background tint, and the
    two boards do not even share a cell pitch. Measuring is the only way in;
    the defaults here are the pilot's and are not assumed to travel.
    """
    return {**DEFAULT_CELLS, **(cells or {})}


def _center(box):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(xs), max(xs)


def _lines(boxes: list[dict], tol: float = 8.0) -> list[list[dict]]:
    items = sorted(boxes, key=lambda b: _center(b["box"])[1])
    lines: list[list[dict]] = []
    for b in items:
        cy = _center(b["box"])[1]
        if lines and abs(_center(lines[-1][0]["box"])[1] - cy) <= tol:
            lines[-1].append(b)
        else:
            lines.append([b])
    return [sorted(l, key=lambda b: _center(b["box"])[0]) for l in lines]


def _fit_cells(strip_boxes: list[dict], player_count: int, cal: dict | None = None) -> tuple[float, float]:
    cal = cell_calibration(cal)
    pts = []
    for b in strip_boxes:
        t = b["text"].strip()
        if t.isdigit() and 1 <= int(t) <= player_count:
            pts.append((int(t), _center(b["box"])[0]))
    if len(pts) >= 3:
        seats = np.array([p[0] for p in pts], float)
        xs = np.array([p[1] for p in pts], float)
        dx, x0 = np.polyfit(seats - 1, xs, 1)
        if 0.8 * cal["cell_dx"] < dx < 1.2 * cal["cell_dx"]:
            return float(x0), float(dx)
    if pts:
        x0 = float(np.median([x - (s - 1) * cal["cell_dx"] for s, x in pts]))
        return x0, cal["cell_dx"]
    return cal["seat1_x"], cal["cell_dx"]


def _classify_background(crop_bgr: np.ndarray, cx: float, cy: float, cal: dict) -> dict:
    """Vote colour from the cell's background tint.

    This board draws a dark red panel behind a reject and a dark olive one
    behind an approve, while the seat digit itself is too dim and too thin to
    survive compression. Measured on BV1kr876AEE1: reject bg H 9-13 / S 130-148,
    approve bg H 27-34 / S 64-80, and a seat that never voted (the forced round)
    stays neutral grey at H 3-7 or ~177 with S 59-68.
    """
    h, w = crop_bgr.shape[:2]
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
    x0, x1 = int(max(0, cx - cal["half_w"])), int(min(w, cx + cal["half_w"] + 1))
    y0, y1 = int(max(0, cy - cal["half_h"])), int(min(h, cy + cal["half_h"] + 1))
    win = hsv[y0:y1, x0:x1].reshape(-1, 3)
    bg = win[win[:, 2] <= cal["bg_value_max"]]
    if len(bg) < cal["min_pixels"]:
        return {"color": "unclear", "outlined": None, "hue": None, "saturation": None}
    hue, sat = float(np.median(bg[:, 0])), float(np.median(bg[:, 1]))
    lo, hi = cal["approve_hue"]
    warm = hue <= cal["warm_hue_max"] or hue >= cal["warm_hue_min"]
    if lo <= hue <= hi and sat < cal["reject_sat_min"]:
        color = "approve"
    elif warm and sat >= cal["reject_sat_min"]:
        color = "reject"
    elif warm:
        color = "none"  # neutral grey: this seat never cast a vote
    else:
        color = "unclear"
    return {"color": color, "outlined": None, "hue": hue, "saturation": sat}


def classify_cell(crop_bgr: np.ndarray, cx: float, cy: float, cal: dict | None = None) -> dict:
    """Vote colour of a seat cell, by whichever signal this board uses."""
    cal = cell_calibration(cal)
    if cal.get("method") == "cell_background":
        return _classify_background(crop_bgr, cx, cy, cal)
    h, w = crop_bgr.shape[:2]
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
    x0, x1 = int(max(0, cx - 9)), int(min(w, cx + 10))
    y0, y1 = int(max(0, cy - 5)), int(min(h, cy + 6))
    win = hsv[y0:y1, x0:x1].reshape(-1, 3)
    ink = win[(win[:, 1] > 45) & (win[:, 2] > 95)]
    if len(win) == 0:
        color, hue, sat = "unclear", None, None
    elif len(ink) < 5:
        color, hue, sat = "none", None, None
    else:
        hue = float(np.median(ink[:, 0]))
        sat = float(np.median(ink[:, 1]))
        if 35 <= hue <= 90:
            color = "approve"
        elif hue <= 22 or hue >= 165:
            color = "reject"
        else:
            color = "unclear"
    outlined = None
    ry0, ry1 = int(cy - 12), int(cy - 7)
    if ry0 >= 0:
        ring = hsv[ry0:ry1, max(0, int(cx - 12)) : min(w, int(cx + 13))].reshape(-1, 3)
        gold = (ring[:, 0] >= 12) & (ring[:, 0] <= 32) & (ring[:, 1] > 50) & (ring[:, 2] > 90)
        outlined = bool(gold.mean() > 0.2)
    return {"color": color, "outlined": outlined, "hue": hue, "saturation": sat}


def _leading_mission(lines: list[list[dict]]) -> int | None:
    """Mission number for rows that appear above the first explicit round header.

    Some boards scroll, and the earliest round's header can be gone while its
    rows are still visible. The board is chronological, so rows above a '第N轮'
    header belong to round N-1. Returns None when nothing can be inferred.
    """
    for line in lines:
        hm = HEADER_RE.search("".join(b["text"] for b in line))
        if hm:
            n = int(hm.group(1))
            return n - 1 if n > 1 else None
    return None


def parse_board(boxes: list[dict], crop_bgr: np.ndarray, player_count: int,
                cells: dict | None = None) -> tuple[list[dict], list[str]]:
    cal = cell_calibration(cells)
    warnings: list[str] = []
    lines = _lines(boxes)
    missions: list[dict] = []
    current: dict | None = None
    row_order = 0
    pending_leading = _leading_mission(lines)
    for i, line in enumerate(lines):
        text = "".join(b["text"] for b in line)
        if current is None and pending_leading is not None and (LEADER_RE.search(text) or MISSION_RE.search(text)):
            current = {"mission": pending_leading, "team_size": None, "proposals": [], "result": None}
            missions.append(current)
            warnings.append(f"rows above the first round header attributed to mission {pending_leading} (scrolled board)")
            pending_leading = None
        hm = HEADER_RE.search(text)
        if hm:
            current = {"mission": int(hm.group(1)), "team_size": int(hm.group(2)), "proposals": [], "result": None}
            missions.append(current)
            continue
        lm = LEADER_RE.search(text)
        if lm:
            if current is None:
                warnings.append(f"proposal row before any mission header: {text}")
                continue
            row_order += 1
            tm = TEAM_RE.search(text)
            team = [int(x) for x in re.findall(r"\d{1,2}", tm.group(1))] if tm else []
            bad = [s for s in team if not 1 <= s <= player_count]
            if bad or len(set(team)) != len(team):
                warnings.append(f"team text unparsable: {text}")
            team = sorted({s for s in team if 1 <= s <= player_count})
            im = INDEX_RE.search(text)
            forced = "必做" in text
            tally_m = None
            # The leader/team prefix contains digits too; look for the tally
            # only after the team list.
            tail = text[tm.end():] if tm else text
            tally_m = TALLY_RE.search(tail)
            result_text = None
            for key in ("否决组队", "通过组队", "组队成功", "必做轮"):
                if key in tail:
                    result_text = key
            if result_text is None:
                # An overlay can eat the second half of the phrase; the verb alone
                # is still the board stating the outcome, not us inferring it.
                for key, full in (("否决", "否决组队"), ("通过", "通过组队")):
                    if key in tail:
                        result_text = full
            cy = float(np.mean([_center(b["box"])[1] for b in line]))
            strip = lines[i + 1] if i + 1 < len(lines) else []
            strip_cy = cy + cal["strip_dy"]
            if strip and abs(np.mean([_center(b["box"])[1] for b in strip]) - strip_cy) <= 8:
                x0, dx = _fit_cells(strip, player_count, cal)
                digit_ys = [_center(b["box"])[1] for b in strip if b["text"].strip().isdigit()]
                if digit_ys:
                    strip_cy = float(np.median(digit_ys))
            else:
                # Falling back to the calibrated geometry is fine; falling back to
                # *another board's* geometry is what read the same row three ways.
                x0, dx = cal["seat1_x"], cal["cell_dx"]
                warnings.append(f"no digit strip found under row '{text}', calibrated cell geometry")
            row_cells = {}
            for seat in range(1, player_count + 1):
                row_cells[str(seat)] = classify_cell(crop_bgr, x0 + (seat - 1) * dx, strip_cy, cal)
            current["proposals"].append({
                "row_order": row_order,
                "proposal_index": int(im.group(1)) if im else None,
                "proposal_limit": int(im.group(2)) if im else None,
                "leader_seat": int(lm.group(1)) if 1 <= int(lm.group(1)) <= player_count else None,
                "team_seats": team,
                "tally": [int(tally_m.group(1)), int(tally_m.group(2))] if tally_m else None,
                "result_text": result_text,
                "forced": forced,
                "cells": row_cells,
                "raw_text": text,
            })
            continue
        mm = MISSION_RE.search(text)
        if mm:
            if current is None:
                warnings.append(f"mission result before any header: {text}")
                continue
            cards = [b["text"] for b in line if b["text"] in ("成功", "失败")]
            # The row also names the seats that ran the mission. That is the
            # passing proposal's team, stated again by the board.
            seats = sorted({int(x) for x in MISSION_TEAM_RE.findall(text) if 1 <= int(x) <= player_count})
            current["result"] = {
                "result": {"成功": "success", "失败": "fail"}[mm.group(1)],
                "card_texts": cards,
                "team_seats": seats,
                "raw_text": text,
            }
    _fill_occluded_team(missions, warnings)
    _fill_proposal_index(missions, warnings)
    return missions, warnings


def _fill_proposal_index(missions: list[dict], warnings: list[str]) -> None:
    """Number a proposal whose '第N/M次组队' text was covered or absent.

    Uses the board's own row order, and only when every proposal in that mission
    that DID state its number agrees with its position — otherwise rows are
    missing and position means nothing, so the index stays null.
    """
    for m in missions:
        rows = m["proposals"]
        stated = [(i, p["proposal_index"]) for i, p in enumerate(rows, 1) if p["proposal_index"] is not None]
        if any(pos != idx for pos, idx in stated):
            warnings.append(f"mission {m['mission']}: stated proposal numbers do not match row order; "
                            f"unnumbered rows left unnumbered")
            continue
        for pos, p in enumerate(rows, 1):
            if p["proposal_index"] is None:
                p["proposal_index"] = pos
                p["index_from_row_order"] = True
                warnings.append(f"mission {m['mission']}: proposal number unreadable on row "
                                f"'{p['raw_text'][:24]}', taken from board row order as {pos}")


def _fill_occluded_team(missions: list[dict], warnings: list[str]) -> None:
    """Recover a proposal team the overlay covered, from its own mission row.

    Only ever applied to the single proposal a mission actually executed, and
    only when its team text read as nothing at all — the seats that ran the
    mission are that proposal's team, said twice by the board. Anything less
    certain is left empty rather than guessed.
    """
    for m in missions:
        res = m.get("result") or {}
        from_row = res.get("team_seats") or []
        if not from_row:
            continue
        ran = [p for p in m["proposals"]
               if p["forced"] or p["result_text"] in ("通过组队", "组队成功")]
        if len(ran) != 1 or ran[0]["team_seats"]:
            continue
        if m["team_size"] and len(from_row) != m["team_size"]:
            warnings.append(
                f"mission {m['mission']} result row lists {len(from_row)} seats but the round needs "
                f"{m['team_size']}; occluded team left empty")
            continue
        ran[0]["team_seats"] = list(from_row)
        ran[0]["team_from_mission_row"] = True
        warnings.append(
            f"mission {m['mission']} proposal team was unreadable (overlay); filled from the mission "
            f"result row's seats {from_row}")


def snapshot_record(
    source_sha: str, start: float, end: float, crop_sha: str, ocr_refs: list[str],
    missions: list[dict], warnings: list[str], crop_path: str | None,
) -> dict:
    rec = {
        "schema": "vbench.board_snapshot/1",
        "snapshot_id": short_id("brd", source_sha, round(start, 4), crop_sha),
        "start": round(start, 4),
        "end": round(end, 4),
        "ocr_refs": ocr_refs,
        "crop_sha256": crop_sha,
        "missions": missions,
        "warnings": warnings,
    }
    if crop_path:
        rec["crop_path"] = crop_path
    return rec


def _event(source_sha: str, stable_key: str, etype: str, payload: dict, snap: dict, row_order: int, flags: list[str], provenance: dict) -> dict:
    return {
        "schema": "vbench.public_event/1",
        "event_id": short_id("evt", source_sha, stable_key),
        "stable_key": stable_key,
        "type": etype,
        "source": "board",
        "payload": payload,
        "observation": {
            "video_start": snap["start"],
            "video_end": snap["end"],
            "evidence_refs": [{"kind": "board_snapshot", "id": snap["snapshot_id"], "video_time": snap["start"]}],
            "row_order": row_order,
        },
        "availability": {
            "status": "unanchored",
            "public_at": None,
            "basis": "board snapshot timing is not public-reveal timing; needs a reviewed anchor",
        },
        "interpretations": [],
        "flags": sorted(set(flags)),
        "review_status": "needs_review",
        "provenance": provenance,
    }


def events_from_snapshots(snapshots: list[dict], source_sha: str, player_count: int, provenance: dict) -> list[dict]:
    """Diff stable snapshots into event candidates.

    First appearance creates the candidate. A later snapshot that reads the same
    row differently never overwrites it: the reading is appended to
    `interpretations` and the event is flagged `board_conflict`.
    """
    events: dict[str, dict] = {}
    order: list[str] = []

    def upsert(key: str, etype: str, payload: dict, snap: dict, row_order: int, flags: list[str]):
        if key not in events:
            events[key] = _event(source_sha, key, etype, payload, snap, row_order, flags, provenance)
            order.append(key)
            return
        ev = events[key]
        ev["observation"]["video_end"] = max(ev["observation"]["video_end"], snap["end"])
        if payload != ev["payload"] and all(payload != it["payload"] for it in ev["interpretations"]):
            ev["interpretations"].append({
                "payload": payload,
                "evidence_refs": [{"kind": "board_snapshot", "id": snap["snapshot_id"], "video_time": snap["start"]}],
                "note": "later snapshot reads this row differently",
            })
            ev["flags"] = sorted(set(ev["flags"]) | {"board_conflict"} | set(flags))

    for snap in sorted(snapshots, key=lambda s: s["start"]):
        for m in snap["missions"]:
            mission = m["mission"]
            for p in m["proposals"]:
                pidx = p["proposal_index"] if p["proposal_index"] is not None else p["row_order"]
                base = f"board:m{mission}:p{pidx}"
                flags = []
                if m["team_size"] and len(p["team_seats"]) != m["team_size"]:
                    flags.append("team_size_mismatch")
                upsert(f"{base}:team_selection", "team_selection", {
                    "mission": mission,
                    "proposal_index": p["proposal_index"],
                    "leader_seat": p["leader_seat"],
                    "team_seats": p["team_seats"],
                    "forced": p["forced"],
                }, snap, p["row_order"], flags)
                outlined = sorted(int(s) for s, c in p["cells"].items() if c["outlined"])
                ev = events[f"{base}:team_selection"]
                # Outline detection is weak (thin 1-2 px gold lines after video
                # compression), so it only raises a conflict when it found a full
                # team's worth of outlines that still disagrees with the text.
                if len(outlined) == len(p["team_seats"]) and outlined != p["team_seats"]:
                    alt = dict(ev["payload"], team_seats=outlined)
                    if all(alt != it["payload"] for it in ev["interpretations"]):
                        ev["interpretations"].append({
                            "payload": alt,
                            "evidence_refs": [{"kind": "board_snapshot", "id": snap["snapshot_id"], "video_time": snap["start"]}],
                            "note": "outlined seat cells disagree with the team text",
                        })
                    ev["flags"] = sorted(set(ev["flags"]) | {"board_conflict"})
                if p["forced"]:
                    continue
                votes = {}
                for s, c in p["cells"].items():
                    if c["color"] == "approve":
                        votes[s] = "approve"
                    elif c["color"] == "reject":
                        votes[s] = "reject"
                    elif c["color"] == "unclear":
                        votes[s] = "unknown"
                    # "none": no vote colour at all -> key absent (not observed).
                vflags = []
                if len(votes) < player_count or "unknown" in votes.values():
                    vflags.append("partial_votes")
                complete = len(votes) == player_count and "unknown" not in votes.values()
                if p["tally"] and complete:
                    approve = sum(v == "approve" for v in votes.values())
                    if [approve, player_count - approve] != p["tally"]:
                        vflags.append("tally_vector_conflict")
                if votes:
                    upsert(f"{base}:vote_observation", "vote_observation", {
                        "mission": mission, "proposal_index": p["proposal_index"], "votes": votes,
                    }, snap, p["row_order"], vflags)
                if p["result_text"] in ("否决组队", "通过组队", "组队成功"):
                    upsert(f"{base}:vote_outcome", "vote_outcome", {
                        "mission": mission,
                        "proposal_index": p["proposal_index"],
                        "result": "rejected" if p["result_text"] == "否决组队" else "passed",
                        "tally_text": f"{p['tally'][0]}:{p['tally'][1]}" if p["tally"] else None,
                        "explicit": True,
                    }, snap, p["row_order"], ["tally_vector_conflict"] if "tally_vector_conflict" in vflags else [])
            if m["result"] and m["result"]["result"] in ("success", "fail"):
                cards = m["result"]["card_texts"]
                # The round header states the size, but it can be clipped off the
                # top of a board that grew past the frame. The result row names the
                # seats that ran, which is the same number from the same row.
                team_size = m["team_size"] or len(m["result"].get("team_seats") or []) or None
                fail_count = None
                if cards and team_size and len(cards) == team_size:
                    fail_count = sum(c == "失败" for c in cards)
                upsert(f"board:m{mission}:mission_outcome", "mission_outcome", {
                    "mission": mission, "result": m["result"]["result"], "fail_count": fail_count,
                }, snap, 1000 + mission, [])
    return [events[k] for k in order]
