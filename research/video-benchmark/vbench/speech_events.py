"""Bounded rule parser: public statement candidates from caption text.

Deliberately small. Every output is a *candidate* needing review. It never
decides that a statement is true, and it never assigns a quoted opinion to
the current speaker: holder is 'speaker' only with a first-person marker,
'unresolved' whenever a reporting or third-person marker is present.

Supported (see SPEC §3): role_claim, stance, intended_team, lady_announcement.
Unsupported on purpose: sarcasm, conditionals ("如果3号是好人"), multi-clause
coreference, stances without an explicit seat number.
"""

from __future__ import annotations

import re

from .textnorm import canonical_numerals
from .util import short_id

SPEECH_STAGE_VERSION = "1"

SEAT = r"(10|[1-9])\s*号"
ROLE_WORDS = {
    "梅林": "merlin", "派西维尔": "percival", "派西": "percival", "忠臣": "loyal", "好人": "good",
    "莫甘娜": "morgana", "莫德雷德": "mordred", "刺客": "assassin", "奥伯伦": "oberon", "坏人": "evil", "狼": "evil",
}
EVIL_ROLE_WORDS = ("莫甘娜", "莫德雷德", "刺客", "奥伯伦", "坏人", "狼", "爪牙")
FIRST_PERSON = re.compile(r"我(觉得|认为|感觉|保|踩|相信|怀疑|倾向|判断|看|估计|投|打)")
REPORTING = re.compile(r"(他|她|它|他们|她们)(说|觉得|认为|感觉|点|讲|认|可能)|说他|说她|点出|(10|[1-9])号(说|觉得|认为|讲|点|认)|听说|人家说|有人说")
HEDGES = re.compile(r"可能|也许|大概|应该|估计|好像|似乎|感觉|有点|一点")
NEGATION_BEFORE = re.compile(r"(不|没|别|非|不是|没有)$")

POSITIVE = [
    (re.compile(SEAT + r"(?:是|很|比较|挺|更|可能|应该|有点|还)?\s*(?:大)?(?:好人|干净|金水|正|可信)"), "good"),
    (re.compile(r"(?:保|相信|信)\s*" + SEAT), "trust"),
]
NEGATIVE = [
    (re.compile(SEAT + r"(?:是|很|比较|挺|更|可能|应该|有点|还)?\s*(?:坏人|狼|有问题|不好|奇怪|可疑|脏|黑)"), "bad"),
    (re.compile(r"(?:踩|打死|打|怀疑|出)\s*" + SEAT), "attack"),
    (re.compile(r"把\s*" + SEAT + r"\s*(?:打死|踩死|踩|投出|出掉)"), "attack"),
    (re.compile(r"盯着(?:这个)?\s*" + SEAT + r"\s*(?:打|踩)"), "attack"),
]
CLAIM = re.compile(r"我(?:就)?(?:是|跳|拍|认)\s*(梅林|派西维尔|派西|忠臣|好人)")
DENY = re.compile(r"我(?:不是|没跳|不跳)\s*(梅林|派西维尔|派西|忠臣|好人)")
INTENDED = re.compile(r"(?:我|我的车|我这车|我要|我会|我想)(?:先|会|要|想|就)?(?:点|带|发|开|出)(?:个车|个|车|的车)?\s*((?:(?:10|[1-9])\s*[号、,，和跟与·\s]*){2,5})")
LADY = re.compile(r"(?:验|查)(?:了)?\s*" + SEAT + r".{0,6}?(好人|坏人|金水|查杀|红|蓝)")


def _holder(text: str, seat: int | None) -> dict:
    if REPORTING.search(text):
        return {"kind": "unresolved", "seat": None, "basis": "reporting or third-person marker present"}
    if FIRST_PERSON.search(text) or text.startswith("我"):
        return {"kind": "speaker", "seat": seat, "basis": "first-person marker"}
    return {"kind": "speaker", "seat": seat, "basis": "no marker: defaulted to speaker, needs review"}


def extract_statements(utterances: list[dict], source_sha: str, provenance: dict) -> list[dict]:
    events: list[dict] = []
    seen: set[str] = set()
    for u in utterances:
        if u.get("caption") is None or u.get("review_status") == "rejected":
            continue
        raw = u["caption"]["text"]
        text = canonical_numerals(raw)
        seat = u["speaker"]["seat"]
        holder = _holder(text, seat)
        base_flags = []
        if holder["kind"] == "unresolved":
            base_flags.append("unresolved_quote")
        elif holder["basis"].startswith("no marker"):
            base_flags.append("no_first_person_marker")

        def emit(etype: str, payload: dict, cue: str, flags: list[str]):
            key = f"speech:{u['utterance_id']}:{etype}:{cue}"
            if key in seen:
                return
            seen.add(key)
            events.append({
                "schema": "vbench.public_event/1",
                "event_id": short_id("evt", source_sha, key),
                "stable_key": key,
                "type": etype,
                "source": "speech",
                "payload": payload,
                "observation": {
                    "video_start": u["caption"]["display_start"],
                    "video_end": u["caption"]["display_end"],
                    "evidence_refs": [{"kind": "utterance", "id": u["utterance_id"], "video_time": u["caption"]["display_start"]}],
                },
                "availability": {
                    "status": "anchored",
                    "public_at": u["availability"]["public_at"],
                    "basis": "same as source utterance",
                    "evidence_refs": [{"kind": "utterance", "id": u["utterance_id"]}],
                },
                "interpretations": [],
                "flags": sorted(set(flags + ["parser_rule"])),
                "review_status": "needs_review",
                "provenance": provenance,
            })

        for m in CLAIM.finditer(text):
            if DENY.search(text):
                break
            emit("role_claim", {"holder": dict(holder, kind="speaker", basis="first-person claim"), "role": ROLE_WORDS[m.group(1)], "claimed": True, "utterance_id": u["utterance_id"]}, m.group(0), [])
        for m in DENY.finditer(text):
            emit("role_claim", {"holder": dict(holder, kind="speaker", basis="first-person denial"), "role": ROLE_WORDS[m.group(1)], "claimed": False, "utterance_id": u["utterance_id"]}, m.group(0), [])

        for patterns, polarity in ((POSITIVE, "positive"), (NEGATIVE, "negative")):
            for pat, _kind in patterns:
                for m in pat.finditer(text):
                    target = int(m.group(1))
                    before = text[: m.start()]
                    negated = bool(NEGATION_BEFORE.search(before[-3:])) or ("不" in m.group(0) and polarity == "positive")
                    hedged = bool(HEDGES.search(raw))
                    flags = list(base_flags)
                    if hedged:
                        flags.append("hedged")
                    if negated:
                        flags.append("negated")
                    emit("stance", {
                        "holder": holder, "target_seat": target, "polarity": polarity,
                        "hedged": hedged, "negated": negated, "cue": m.group(0), "utterance_id": u["utterance_id"],
                    }, m.group(0), flags)
        for m in re.finditer(SEAT + r".{0,6}?(" + "|".join(EVIL_ROLE_WORDS) + ")", text):
            target = int(m.group(1))
            flags = list(base_flags) + (["hedged"] if HEDGES.search(raw) else [])
            emit("stance", {
                "holder": holder, "target_seat": target, "polarity": "negative",
                "hedged": bool(HEDGES.search(raw)), "negated": False, "cue": m.group(0), "utterance_id": u["utterance_id"],
            }, m.group(0), flags)

        for m in INTENDED.finditer(text):
            seats = sorted({int(x) for x in re.findall(r"10|[1-9]", m.group(1))})
            if len(seats) >= 2:
                emit("intended_team", {"holder": holder, "team_seats": seats, "utterance_id": u["utterance_id"]}, m.group(0), list(base_flags))

        if "湖" in text or "验" in text or "查" in text:
            for m in LADY.finditer(text):
                word = m.group(2)
                announced = "good" if word in ("好人", "金水", "蓝") else "evil" if word in ("坏人", "查杀", "红") else "unknown"
                emit("lady_announcement", {"holder_seat": seat, "target_seat": int(m.group(1)), "announced": announced, "utterance_id": u["utterance_id"]}, m.group(0), list(base_flags))
    return events
