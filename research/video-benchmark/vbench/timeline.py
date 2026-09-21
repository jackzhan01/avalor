"""Chronological public game record (timeline revision).

One ordered stream of original speech (grouped into turns and turn parts) and
objective public events, plus explicit coverage gaps. The readable transcript
and agent-facing X are both projections of `assemble()` output, so they cannot
disagree with the canonical record.

Order: immutable ledger `sequence` (availability in the edited video, late but
never early). `order` in the record is a per-build presentation index.

Prefix safety: every grouping decision for a segment depends only on records
with a smaller sequence (the previous segment, events/gaps/exclusions since
it, and boundary corrections targeting this segment). Assembling a prefix
therefore yields exactly the items of the full assembly truncated at the
cutoff, with the last part possibly shorter; future records never change the
IDs, text or grouping of earlier material.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .corrections import content_sha
from .util import read_json, read_jsonl, sha256_json, short_id

OBJECTIVE_EVENT_TYPES = frozenset({"team_selection", "vote_observation", "vote_outcome", "mission_outcome", "lady_transfer", "assassination"})
TEXT_JOIN = " "
TEXT_JOIN_POLICY = "subtitle cards joined with a single U+0020 space; no punctuation is added or removed"
ORDER_SEMANTICS = (
    "timeline order follows the immutable ledger sequence (public availability in the edited video); "
    "`order` is a presentation index renumbered per build, `source_sequence` is never renumbered or reused"
)
GAP_NOTE_X = "视频此处有剪辑缺口：部分公开过程没有出现在画面中。"


@dataclass
class TurnConfig:
    max_gap_s: float = 4.0
    review_pause_s: float = 1.5

    @classmethod
    def from_dict(cls, d: dict | None) -> "TurnConfig":
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def segment_fingerprint(u: dict) -> str:
    """What a turn-boundary reviewer looked at: identity, text, timing, speaker."""
    cap = u.get("caption") or {}
    return sha256_json([u["utterance_id"], cap.get("text") or u["asr"].get("text"), cap.get("display_start"), cap.get("display_end"), u["speaker"]["seat"]])


# ── atom selection ─────────────────────────────────────────────────────────


def _status_ok(rec: dict, dataset: str) -> bool:
    if dataset == "accepted":
        return rec.get("review_status") == "accepted"
    return rec.get("review_status") != "rejected"


def select_atoms(utterances: list[dict], events: list[dict], dataset: str, live_end: float | None = None) -> tuple[list[dict], dict]:
    """Eligible speech segments and objective events, in ledger order.

    Returns (atoms, exclusions). Exclusions are atoms that would be speech but are
    not eligible in this dataset (e.g. unreviewed captions in the accepted set);
    they still act as turn boundaries so missing words are never silently bridged.
    """
    atoms = []
    stats = {"semantic_events_excluded": 0, "unsequenced": 0, "unanchored_events": 0, "status_excluded_segments": 0, "status_excluded_events": 0, "postgame_excluded": 0}
    for u in utterances:
        if u.get("sequence") is None or u["availability"]["status"] != "anchored":
            stats["unsequenced"] += 1
            continue
        if u.get("review_status") == "rejected":
            continue
        speechlike = u["eligibility"] == "in_game_speech" or (dataset == "draft" and u["eligibility"] == "unknown")
        start = u["caption"]["display_start"] if u.get("caption") else u["asr"]["audio_start"]
        if live_end is not None and start >= live_end:
            stats["postgame_excluded"] += 1
            continue
        if speechlike and _status_ok(u, dataset):
            atoms.append({"kind": "segment", "seq": u["sequence"], "public_at": u["availability"]["public_at"], "rec": u})
        elif u["eligibility"] in ("in_game_speech", "unknown"):
            stats["status_excluded_segments"] += 1
            atoms.append({"kind": "excluded", "seq": u["sequence"], "public_at": u["availability"]["public_at"], "rec": u})
    for e in events:
        if e["type"] not in OBJECTIVE_EVENT_TYPES:
            stats["semantic_events_excluded"] += 1
            continue
        if e.get("sequence") is None or e["availability"]["status"] != "anchored":
            stats["unanchored_events"] += 1
            continue
        if live_end is not None and e["availability"]["public_at"] >= live_end:
            stats["postgame_excluded"] += 1
            continue
        if not _status_ok(e, dataset):
            stats["status_excluded_events"] += 1
            continue
        atoms.append({"kind": "event", "seq": e["sequence"], "public_at": e["availability"]["public_at"], "rec": e})
    atoms.sort(key=lambda a: a["seq"])
    return atoms, stats


def load_boundary_decisions(path: Path | None) -> list[dict]:
    return read_jsonl(path) if path and path.exists() else []


# ── assembly ───────────────────────────────────────────────────────────────


def _seg_view(u: dict, machine_text: str | None, gap_before: float | None) -> dict:
    cap = u.get("caption")
    if cap is None:
        text, origin, start, end = u["asr"]["text"], "machine_asr", u["asr"]["audio_start"], u["asr"]["audio_end"]
    else:
        text, start, end = cap["text"], cap["display_start"], cap["display_end"]
        if u.get("origin") == "correction":
            origin = "reviewer_added_caption"
        elif u.get("review_status") == "accepted":
            origin = "reviewed_caption_corrected" if machine_text is not None and machine_text != text else "reviewed_caption_confirmed"
        else:
            origin = "machine_ocr"
    return {
        "segment_id": u["utterance_id"],
        "source": "caption" if cap is not None else "asr_only",
        "text": text,
        "text_origin": origin,
        "machine_text": machine_text if cap is not None else None,
        "start": start,
        "end": end,
        "public_at": u["availability"]["public_at"],
        "source_sequence": u["sequence"],
        "review_status": u["review_status"],
        "gap_before_s": None if gap_before is None else round(gap_before, 4),
        "asr_text": u["asr"].get("text"),
        "flags": sorted(u.get("flags", [])),
    }


def assemble(
    atoms: list[dict],
    gaps: list[dict],
    machine_text: dict[str, str | None],
    boundary_decisions: list[dict],
    tcfg: TurnConfig,
    late_keys: dict[str, str],
    until_public_at: float | None = None,
) -> tuple[list[dict], dict]:
    """Group segments into turns/parts and interleave events and gaps. Causal."""
    decisions: dict[str, dict] = {}
    report = {"boundary_applied": [], "boundary_stale": []}
    effective: dict[str, str] = {}
    for d in sorted(boundary_decisions, key=lambda d: d["revision"]):
        key = d["after_segment"]["id"]
        prior = effective.get(key)
        if prior is not None and d.get("supersedes") != prior:
            report["boundary_stale"].append({"correction_id": d["correction_id"], "reason": "conflict: missing supersedes"})
            continue
        decisions[key] = d
        effective[key] = d["correction_id"]

    gaps = sorted(gaps, key=lambda g: g["start"])
    gi = 0
    items: list[dict] = []
    part: dict | None = None
    turn_id: str | None = None
    part_index = 0
    last_seg: dict | None = None
    since = {"event": False, "gap": False, "excluded": False}

    def emit_gap(g):
        nonlocal part
        items.append({
            "kind": "coverage_gap",
            "item_id": short_id("gap", g["gap_id"]),
            "gap_id": g["gap_id"],
            "gap_kind": g["kind"],
            "start": g["start"],
            "end": g["end"],
            "public_at": g["start"],
            "description": g["description"],
            "omitted": g["omitted"],
        })
        part = None
        since["gap"] = True

    for atom in atoms:
        while gi < len(gaps) and gaps[gi]["start"] < atom["public_at"]:
            emit_gap(gaps[gi])
            gi += 1
        rec = atom["rec"]
        if atom["kind"] == "excluded":
            part = None
            since["excluded"] = True
            continue
        if atom["kind"] == "event":
            items.append({
                "kind": "event",
                "item_id": short_id("ev", rec["event_id"]),
                "event_id": rec["event_id"],
                "type": rec["type"],
                "payload": {k: v for k, v in rec["payload"].items() if k != "utterance_id"},
                "source_sequence": rec["sequence"],
                "public_at": rec["availability"]["public_at"],
                "observed_at": rec["observation"]["video_start"],
                "availability_basis": rec["availability"].get("basis", ""),
                "reporting": ({"status": "retrospective", "gap_id": late_keys[rec["stable_key"]]} if rec.get("stable_key") in late_keys else {"status": "live"}),
                "review_status": rec["review_status"],
                "flags": sorted(rec.get("flags", [])),
            })
            part = None
            since["event"] = True
            continue

        # speech segment
        cap = rec.get("caption")
        start = cap["display_start"] if cap else rec["asr"]["audio_start"]
        seat = rec["speaker"]["seat"]
        gap_s = None if last_seg is None else start - last_seg["end"]
        reasons: list[str] = []
        source = "rule"
        if last_seg is None:
            reasons = ["start"]
        else:
            if seat != last_seg["seat"]:
                reasons.append("speaker_change")
            if seat is None or last_seg["seat"] is None:
                reasons.append("unknown_speaker")
            if gap_s is not None and gap_s > tcfg.max_gap_s:
                reasons.append("long_gap")
            if since["gap"]:
                reasons.append("coverage_gap")
            if since["excluded"]:
                reasons.append("excluded_segment_between")
        reviewed_join = False
        d = decisions.get(rec["utterance_id"])
        if d is not None and last_seg is not None:
            if d["before_segment"]["id"] != last_seg["id"] or d["before_segment"]["content_sha256"] != last_seg["fp"] or d["after_segment"]["content_sha256"] != segment_fingerprint(rec):
                report["boundary_stale"].append({"correction_id": d["correction_id"], "reason": "stale: segments changed or no longer adjacent"})
            elif d["decision"] == "break":
                if not reasons:
                    reasons = ["reviewed_break"]
                    source = "reviewed_correction"
                report["boundary_applied"].append(d["correction_id"])
            elif d["decision"] == "join":
                hard = {"speaker_change", "coverage_gap", "excluded_segment_between"} & set(reasons)
                if hard or seat is None:
                    report["boundary_stale"].append({"correction_id": d["correction_id"], "reason": f"join refused across {sorted(hard) or ['unknown_speaker']}"})
                else:
                    reasons = []
                    source = "reviewed_correction"
                    reviewed_join = True
                    report["boundary_applied"].append(d["correction_id"])

        seg = _seg_view(rec, machine_text.get(rec["utterance_id"]), gap_s)
        new_turn = bool(reasons)
        new_part = new_turn or part is None
        if new_turn:
            turn_id = short_id("turn", rec["utterance_id"])
            part_index = 0
            btype = "start" if reasons == ["start"] else "new_turn"
        elif new_part:
            part_index += 1
            btype = "new_part"
            reasons = ["objective_event"] if since["event"] else ["coverage_gap"]
        if new_part:
            part = {
                "kind": "speech",
                "item_id": short_id("part", rec["utterance_id"]),
                "turn_id": turn_id,
                "part_index": part_index,
                "continues_turn": part_index > 0,
                "seat": seat,
                "speaker_basis": rec["speaker"]["attribution"],
                "text": seg["text"],
                "segments": [seg],
                "start": seg["start"],
                "end": seg["end"],
                "public_at": seg["public_at"],
                "time_basis": "edited_video_caption_display",
                "boundary_before": {"type": btype, "reasons": reasons, "source": source, "gap_s": None if gap_s is None else round(gap_s, 4)},
                "flags": set(),
            }
            items.append(part)
        else:
            part["segments"].append(seg)
            part["text"] = part["text"] + TEXT_JOIN + seg["text"]
            part["end"] = seg["end"]
            part["public_at"] = seg["public_at"]
            if gap_s is not None and gap_s > tcfg.review_pause_s:
                part["flags"].add("long_pause")
            if rec["speaker"]["attribution"] != "label_stable" and part["speaker_basis"] == "label_stable":
                part["speaker_basis"] = rec["speaker"]["attribution"]
        if reviewed_join:
            part["flags"].add("reviewed_join")
        f = set(rec.get("flags", []))
        if seat is None:
            part["flags"].add("speaker_unknown")
        if rec["speaker"]["attribution"] == "label_transition":
            part["flags"].add("speaker_transition")
        if "overlap_suspected" in f:
            part["flags"].add("overlap_suspected")
        if cap is None:
            part["flags"].add("asr_only_segment")
        if rec["review_status"] != "accepted":
            part["flags"].add("unreviewed_segment")
        last_seg = {"id": rec["utterance_id"], "seat": seat, "end": seg["end"], "fp": segment_fingerprint(rec)}
        since = {"event": False, "gap": False, "excluded": False}

    while gi < len(gaps) and (until_public_at is None or gaps[gi]["start"] <= until_public_at):
        emit_gap(gaps[gi])
        gi += 1
    for it in items:
        if it["kind"] == "speech":
            it["flags"] = sorted(it["flags"])
    return items, report


# ── context (archival only: may look ahead) ─────────────────────────────────


def derive_context(items: list[dict]) -> None:
    """Mission / attempt headings for the archival record and readable transcript.

    Uses look-ahead (the next formal team selection) to label a discussion, so it
    is never copied into X.
    """
    next_ts: list[tuple[int, int | None] | None] = [None] * len(items)
    upcoming = None
    for i in range(len(items) - 1, -1, -1):
        it = items[i]
        if it["kind"] == "event" and it["type"] == "team_selection":
            upcoming = (it["payload"].get("mission"), it["payload"].get("proposal_index"))
        next_ts[i] = upcoming
    mission = attempt = None
    phase = "unknown"
    basis = "no evidence yet"
    pending = None
    for i, it in enumerate(items):
        if it["kind"] == "event":
            p = it["payload"]
            m, a = p.get("mission"), p.get("proposal_index")
            if it["type"] == "team_selection":
                mission, attempt, phase, basis = m, a, "after_team_selection", "formal team selection"
                pending = None
            elif it["type"] in ("vote_observation", "vote_outcome"):
                mission, attempt, phase, basis = m, a, "after_vote", "vote record"
                if it["type"] == "vote_outcome" and p.get("result") == "rejected":
                    pending = (m, (a + 1) if a else None, "after rejected vote")
                elif it["type"] == "vote_outcome":
                    pending = None
            elif it["type"] == "mission_outcome":
                mission, phase, basis = m, "after_mission", "mission outcome"
                pending = ((m + 1) if m and m < 5 else None, 1, "after mission outcome")
            it["context"] = {"mission": mission, "attempt": attempt, "phase": phase, "basis": basis}
            continue
        if pending is not None:
            mission, attempt, phase, basis = pending[0], pending[1], "discussion", pending[2]
            nxt = next_ts[i]
            if nxt and nxt[0] == mission and nxt[1] is not None and attempt is not None and nxt[1] != attempt:
                basis += f"; next board row says attempt {nxt[1]} (conflict, review)"
            pending = None
        elif mission is None and next_ts[i] is not None:
            mission, attempt, phase, basis = next_ts[i][0], next_ts[i][1], "discussion", "next formal team selection (look-ahead)"
        it["context"] = {"mission": mission, "attempt": attempt, "phase": phase if mission is not None else "unknown", "basis": basis}


# ── canonical record ───────────────────────────────────────────────────────


def _merge_intervals(iv: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _subtract(interval: list[float], covered: list[list[float]]) -> list[list[float]]:
    out, cur = [], interval[0]
    for a, b in _merge_intervals(covered):
        if b <= cur or a >= interval[1]:
            continue
        if a > cur:
            out.append([round(cur, 3), round(a, 3)])
        cur = max(cur, b)
    if cur < interval[1]:
        out.append([round(cur, 3), round(interval[1], 3)])
    return out


def build_game_record(
    *,
    cfg: dict,
    source_id: str,
    dataset: str,
    utterances: list[dict],
    events: list[dict],
    machine_utterances: list[dict],
    coverage: dict | None,
    review_scope: dict | None,
    boundary_decisions: list[dict],
    audit: dict,
) -> tuple[dict, dict]:
    tcfg = TurnConfig.from_dict(cfg.get("turns"))
    live = (coverage or {}).get("live_game_interval")
    atoms, sel = select_atoms(utterances, events, dataset, live[1] if live else None)
    gaps = [g for g in (coverage or {}).get("gaps", []) if cfg["interval"]["start"] <= g["start"] < cfg["interval"]["end"]]
    late = {k: g["gap_id"] for g in gaps for k in g["late_reported_event_keys"]}
    machine_text = {u["utterance_id"]: (u["caption"] or {}).get("text") for u in machine_utterances}
    items, arep = assemble(atoms, gaps, machine_text, boundary_decisions, tcfg, late)
    derive_context(items)
    for i, it in enumerate(items, 1):
        it["order"] = i

    reviewed = [list(x) for x in (review_scope or {}).get("intervals", [])]
    interval = [cfg["interval"]["start"], cfg["interval"]["end"]]
    speech = [it for it in items if it["kind"] == "speech"]
    counts = {
        "speech_parts": len(speech),
        "speech_turns": len({it["turn_id"] for it in speech}),
        "segments_included": sum(len(it["segments"]) for it in speech),
        "segments_unreviewed_included": sum(1 for it in speech for s in it["segments"] if s["review_status"] != "accepted"),
        "segments_asr_only_included": sum(1 for it in speech for s in it["segments"] if s["source"] == "asr_only"),
        "events_by_type": {},
        "retrospective_events": sum(1 for it in items if it["kind"] == "event" and it["reporting"]["status"] == "retrospective"),
        "coverage_gaps": sum(1 for it in items if it["kind"] == "coverage_gap"),
        "selection": sel,
        "boundary_corrections_applied": len(arep["boundary_applied"]),
        "boundary_corrections_stale": arep["boundary_stale"],
    }
    for it in items:
        if it["kind"] == "event":
            counts["events_by_type"][it["type"]] = counts["events_by_type"].get(it["type"], 0) + 1
    notes = [
        "Captions are the edited burned-in subtitles; reviewed text is checked against pixels, not against audio.",
        "Caption coverage is not proof that all spoken audio is covered: speech the edit did not subtitle or cut away is absent.",
    ]
    if dataset == "draft":
        notes.append("DRAFT: includes machine candidates and unreviewed ASR-only speech; not a reviewed dataset.")
    rules = {k: v for k, v in cfg["rules"].items() if k != "basis"}
    record = {
        "schema": "vbench.game_record/1",
        "record_id": short_id("rec", source_id, cfg["run_id"], dataset),
        "dataset": dataset,
        "draft": dataset != "accepted",
        "order_semantics": ORDER_SEMANTICS,
        "text_join": TEXT_JOIN_POLICY,
        "rules": rules,
        "rules_basis": cfg["rules"].get("basis", {}),
        "coverage": {
            "interval": interval,
            "reviewed_intervals": _merge_intervals(reviewed),
            "unreviewed_intervals": _subtract(interval, reviewed),
            "gaps": gaps,
            "counts": counts,
            "notes": notes,
        },
        "source_audit": dict(audit, source_id=source_id, run_id=cfg["run_id"]),
        "timeline": items,
    }
    return record, arep


def load_coverage(path: Path | None) -> dict | None:
    return read_json(path) if path and path.exists() else None


__all__ = [
    "OBJECTIVE_EVENT_TYPES", "TurnConfig", "assemble", "build_game_record", "derive_context", "select_atoms",
    "segment_fingerprint", "content_sha", "GAP_NOTE_X",
]
