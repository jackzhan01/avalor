"""PRIVATE LAYER. Answer-bearing roster crops, role labels and Y targets.

Only the CLI's private commands and the Y half of sample export import this
module. Public extraction and X construction must not (import-graph test).
"""

from __future__ import annotations

from pathlib import Path

import cv2

from .layout import Layout, crop_region
from .util import array_sha256, read_json, write_bytes, write_json
from .validate import ROLE_SIDE, ValidationFailed, private_roles_errors, schema_errors


def load_roles(path: Path) -> dict:
    doc = read_json(path)
    errs = schema_errors("private_roles", doc) or private_roles_errors(doc)
    if errs:
        raise ValidationFailed(errs)
    return doc


def roster_evidence(video: Path, layout: Layout, times: list[float], out_dir: Path, ocr_engine=None) -> list[dict]:
    """Save roster crops (private dir only) and optional raw OCR as authoring aids.

    OCR output here is a reading aid, never a label: a human fills roles.json
    from the crops and records each crop hash as evidence.
    """
    from .media import grab_frames

    regions = [r for r in layout.regions if r.visibility == "private" and r.kind == "roster"]
    out = []
    for t, frame in grab_frames(video, times):
        for r in regions:
            crop = crop_region(frame, r)
            sha = array_sha256(crop)
            rel = out_dir / f"roster_{t:08.3f}_{sha[:12]}.png"
            ok, buf = cv2.imencode(".png", crop)
            write_bytes(rel, buf.tobytes())
            rec = {"video_time": round(t, 3), "region_id": r.id, "crop_sha256": sha, "crop_path": str(rel)}
            if ocr_engine is not None:
                rec["ocr_boxes"] = ocr_engine.run(crop, "page2x")
            out.append(rec)
    write_json(out_dir / "roster_evidence.json", out)
    return out


def build_y(roles: dict | None, sample_id: str, dataset: str) -> dict:
    n = roles["player_count"] if roles else 10
    targets = {}
    verified = 0
    for seat in range(1, n + 1):
        entry = next((s for s in roles["seats"] if s["seat"] == seat), None) if roles else None
        if entry is None or entry["verification"] == "unknown":
            targets[str(seat)] = {"role": "unknown", "side": "unknown", "verification": "unknown"}
            continue
        if dataset == "accepted" and entry["verification"] != "verified":
            # Candidates never become targets in the accepted dataset.
            targets[str(seat)] = {"role": "unknown", "side": "unknown", "verification": "unknown"}
            continue
        targets[str(seat)] = {"role": entry["role"], "side": ROLE_SIDE[entry["role"]], "verification": entry["verification"]}
        verified += entry["verification"] == "verified"
    return {
        "schema": "vbench.sample_y/1",
        "sample_id": sample_id,
        "draft": dataset != "accepted",
        "targets": {"roles": targets},
        "coverage": {"verified_seats": verified, "total_seats": n},
        "scoring_mode": "full" if verified == n else ("partial" if verified else "none"),
        "evidence_refs": [],
        "constraint_checks": None,
    }


# ── timeline revision: private roster v2 and Y v2 ──────────────────────────


def load_roster_v2(path: Path) -> dict:
    doc = read_json(path)
    errs = schema_errors("private_roster", doc) or roster_v2_errors(doc)
    if errs:
        raise ValidationFailed(errs)
    return doc


def roster_v2_errors(doc: dict) -> list[str]:
    errs = []
    seats = [s["seat"] for s in doc["seats"]]
    if sorted(seats) != list(range(1, doc["player_count"] + 1)):
        errs.append("roster seats must cover 1..N exactly once")
    counts: dict = {}
    for s in doc["seats"]:
        if s["role"] == "unknown":
            if s["verification"] == "verified" or s["side"] != "unknown":
                errs.append(f"seat {s['seat']}: unknown role cannot be verified or sided")
            continue
        if ROLE_SIDE[s["role"]] != s["side"]:
            errs.append(f"seat {s['seat']}: side does not match role")
        if s["verification"] == "verified":
            if not s["sources"]:
                errs.append(f"seat {s['seat']}: verified without sources")
            if not s["consistency"]["agree"]:
                errs.append(f"seat {s['seat']}: verified despite disagreeing observations")
            counts[s["role"]] = counts.get(s["role"], 0) + 1
    for role, c in counts.items():
        if c > doc["composition"].get(role, 0):
            errs.append(f"verified {role} x{c} exceeds composition")
    return errs


def build_y_v2(roster: dict | None, sample_id: str, dataset: str) -> dict:
    n = roster["player_count"] if roster else 10
    targets, verified = {}, 0
    for seat in range(1, n + 1):
        e = next((s for s in roster["seats"] if s["seat"] == seat), None) if roster else None
        if e is None or e["role"] == "unknown" or (dataset == "accepted" and e["verification"] != "verified"):
            # A hidden role is reported as unknown, never as a partially trusted guess.
            targets[str(seat)] = {"role": "unknown", "side": "unknown", "verification": "unknown"}
            continue
        v = e["verification"] if e["verification"] in ("verified", "candidate") else "candidate"
        targets[str(seat)] = {"role": e["role"], "side": e["side"], "verification": v}
        verified += v == "verified"
    return {
        "schema": "vbench.sample_y/2",
        "sample_id": sample_id,
        "draft": dataset != "accepted",
        "targets": {"roles": targets},
        "coverage": {"verified_seats": verified, "total_seats": n},
        "scoring_mode": "full" if verified == n else ("partial" if verified else "none"),
        "evidence_refs": [],
        "constraint_checks": None,
        "roster_verification": ({"end_of_video_reveal": roster["end_of_video_reveal"], "notes": roster["notes"]} if roster else {"available": False}),
    }


ROLE_WORDS_ZH = {"忠臣": "loyal", "梅林": "merlin", "派西维尔": "percival", "莫甘娜": "morgana", "莫德雷德": "mordred", "刺客": "assassin", "奥伯伦": "oberon", "爪牙": "minion"}


# ── agent-pair revision: the label file opened beside an input document ────


def build_label_v3(roster: dict | None, sample_id: str, input_sha256: str, dataset: str) -> dict:
    """Per-seat identity for one input document, plus optional targets that stay
    null unless the public record actually showed them.

    The assassination and the winner are never inferred: this upload ends inside
    mission 3, and post-game chatter is a player's remark, not a reveal.
    """
    y = build_y_v2(roster, "x2-" + "0" * 16, dataset)
    seats = y["targets"]["roles"]
    assassin = next((int(s) for s, t in seats.items() if t["role"] == "assassin" and t["verification"] == "verified"), None)
    notes = [
        "身份来自私有区域（制作方名单叠层或片尾揭示），不是对局中的公开信息；评分用，不随 input 发送。",
        "assassination_* 与 winning_side 只有在源片给出公开揭示时才填，否则保持 null，不从赛后闲聊或部分信息推断。",
    ]
    outcome = (roster or {}).get("final_outcome") or {}
    targets = {
        "assassin_seat": outcome.get("assassin_seat", assassin) if outcome else assassin,
        "assassination_target_seat": outcome.get("assassination_target_seat"),
        "assassination_hit": outcome.get("assassination_hit"),
        "winning_side": outcome.get("winning_side"),
    }
    if outcome:
        notes.append(f"终局字段来源：{outcome.get('basis', '')}")
    if roster is not None:
        notes.append(f"end_of_video_reveal.available = {bool(roster['end_of_video_reveal']['available'])}")
    return {
        "schema": "vbench.agent_label/1",
        "sample_id": sample_id,
        "input_sha256": input_sha256,
        "draft": dataset != "accepted",
        "seats": seats,
        "role_enum": sorted(ROLE_SIDE),
        "side_enum": ["good", "evil"],
        "optional_targets": targets,
        "scoring": {"primary": "seat_roles", "mode": y["scoring_mode"],
                    "verified_seats": y["coverage"]["verified_seats"], "total_seats": y["coverage"]["total_seats"]},
        "notes": notes,
    }


def _pair_roster(boxes: list[dict]) -> list[tuple[str, str]]:
    """(nickname, role word) pairs: the role word sits ~30 px under its nickname."""

    def c(b):
        xs = [p[0] for p in b["box"]]
        ys = [p[1] for p in b["box"]]
        return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2

    roles = [b for b in boxes if b["text"] in ROLE_WORDS_ZH]
    names = [b for b in boxes if b["text"] not in ROLE_WORDS_ZH and not b["text"].isdigit() and len(b["text"]) >= 2 and b["text"] != "暂离"]
    out = []
    for r in roles:
        rx, ry = c(r)
        cands = [n for n in names if abs(c(n)[0] - rx) < 60 and 12 < ry - c(n)[1] < 50]
        if cands:
            n = min(cands, key=lambda n: ry - c(n)[1])
            out.append((n["text"], r["text"]))
    return out


def build_roster_v2(roles_v1: dict, video: Path, layout: Layout, times: list[float], out_dir: Path, ocr_engine,
                    video_end: float, reveal_note: str | None = None) -> dict:
    """Producer-roster consistency across the whole video; no end-of-game reveal is invented."""
    from .textnorm import similar

    ev = roster_evidence(video, layout, times, out_dir, ocr_engine)
    nick = {}
    for s in roles_v1["seats"]:
        txt = next((e["observed_text"] for e in s["evidence"] if e["kind"] == "roster_crop"), "")
        parts = [p.strip() for p in txt.split("/")]
        nick[s["seat"]] = parts[1] if len(parts) >= 3 else None
    seats = []
    for s in roles_v1["seats"]:
        obs, disagree = [], []
        for e in ev:
            pairs = _pair_roster(e.get("ocr_boxes", []))
            mine = nick[s["seat"]]
            hit = [w for n, w in pairs if mine and (n == mine or similar(n, mine, 0.34))]
            # A fuzzy name match that also fits another seat's nickname proves
            # nothing: this roster has both "Jerry" and "Jeremy", two edits apart,
            # and the loose match paired seat 9 with seat 6's role.
            others = [o for o in nick.values() if o and o != mine]
            if hit and not any(n == mine for n, _ in pairs) and                     any(similar(n, o, 0.34) for n, _ in pairs for o in others if similar(n, mine, 0.34)):
                continue
            if not hit:
                continue
            if any(n == mine for n, _ in pairs):
                hit = [w for n, w in pairs if n == mine]
            obs.append(e["video_time"])
            if ROLE_WORDS_ZH[hit[0]] != s["role"]:
                disagree.append({"video_time": e["video_time"], "observed_role_word": hit[0]})
        agree = bool(obs) and not disagree
        verification = s["verification"] if agree else ("needs_review" if disagree else "candidate")
        seats.append({
            "seat": s["seat"],
            "role": s["role"],
            "side": ROLE_SIDE.get(s["role"], "unknown"),
            "verification": verification,
            "sources": [dict(x) for x in s["evidence"]] + [{"kind": "roster_ocr_consistency", "video_time": e["video_time"], "crop_sha256": e["crop_sha256"]} for e in ev],
            "consistency": {"checked_times": obs, "agree": agree, "disagreements": disagree},
        })
    return {
        "schema": "vbench.private_roster/2",
        "game_id": roles_v1["game_id"],
        "player_count": roles_v1["player_count"],
        "composition": roles_v1["composition"],
        "seats": seats,
        "end_of_video_reveal": {
            "available": False,
            "checked_interval": [times[-1] if times else None, video_end],
            # Was hard-coded to describe the first source. A per-source fact has
            # to come from the caller that checked it.
            "note": reveal_note or "本函数不判断片尾是否有身份揭示；身份只来自制作方观众名单叠层。",
            "agrees_with_roster": None,
        },
        "notes": [
            "Single source channel (producer spectator roster). Consistency = same role word for the seat's nickname at every checked time.",
            "Nickname-to-seat join uses the public speaker labels and the roster's seat badges.",
        ],
    }
