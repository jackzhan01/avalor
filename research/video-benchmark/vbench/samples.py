"""Agent-facing context X at an explicit cutoff sequence.

Inputs are public view records and confirmed rules only; this module has no
parameter or import through which private labels could arrive. Output bytes
depend only on the public prefix up to the cutoff.
"""

from __future__ import annotations

from .util import canonical_json, sha256_bytes

SUPPORTED_PERSPECTIVES = ("public_observer",)


class UnsupportedPerspective(ValueError):
    pass


class CutoffError(ValueError):
    pass


def check_perspective(perspective: str) -> None:
    if perspective not in SUPPORTED_PERSPECTIVES:
        raise UnsupportedPerspective(
            f"视角 {perspective!r} 不支持：V1 只有 public_observer。玩家视角需要经授权的私有知识建模，本版明确拒绝，而不是生成占位样本。"
        )


def _eligible(rec: dict, dataset: str) -> bool:
    status = rec.get("review_status")
    if dataset == "accepted":
        return status == "accepted"
    if dataset == "draft":
        return status != "rejected"
    raise ValueError(dataset)


def resolve_cutoff(events: list[dict], utterances: list[dict], after: dict) -> dict:
    """Find the record a cutoff spec points at. Prefer game events."""
    if "sequence" in after:
        for r in events + utterances:
            if r.get("sequence") == after["sequence"]:
                return r
        raise CutoffError(f"no record with sequence {after['sequence']}")
    if "event" in after:
        want = after["event"]
        hits = [
            e for e in events
            if e["type"] == want["type"] and all(e["payload"].get(k) == v for k, v in want.items() if k != "type")
        ]
        hits = [e for e in hits if e.get("sequence") is not None]
        if len(hits) != 1:
            raise CutoffError(f"cutoff event {want} matched {len(hits)} sequenced records")
        return hits[0]
    if "utterance_id" in after:
        for u in utterances:
            if u["utterance_id"] == after["utterance_id"] and u.get("sequence") is not None:
                return u
        raise CutoffError(f"cutoff utterance {after['utterance_id']} not sequenced")
    raise CutoffError(f"unsupported cutoff spec {after}")


def sample_id_for(game_id: str, dataset: str, perspective: str, cutoff_sequence: int) -> str:
    return "x-" + sha256_bytes(f"{game_id}|{dataset}|{perspective}|{cutoff_sequence}".encode())[:16]


def build_x(
    *, utterances: list[dict], events: list[dict], cutoff_sequence: int, rules: dict,
    sample_id: str, dataset: str, perspective: str = "public_observer",
) -> dict:
    check_perspective(perspective)
    by_seq = {r["sequence"]: r for r in utterances + events if r.get("sequence") is not None}
    if cutoff_sequence not in by_seq:
        raise CutoffError(f"cutoff sequence {cutoff_sequence} has no record")
    cutoff_rec = by_seq[cutoff_sequence]
    if not _eligible(cutoff_rec, dataset):
        raise CutoffError(f"cutoff record {cutoff_sequence} is not eligible for the {dataset} dataset")
    t_cut = cutoff_rec["availability"]["public_at"]

    utt_seq = {u["utterance_id"]: u["sequence"] for u in utterances if u.get("sequence") is not None}
    history = []
    for seq in sorted(by_seq):
        if seq > cutoff_sequence:
            break
        r = by_seq[seq]
        av = r["availability"]
        if not _eligible(r, dataset) or av["status"] != "anchored" or av["public_at"] is None or av["public_at"] > t_cut + 1e-9:
            continue
        if "utterance_id" in r:
            if r["eligibility"] != "in_game_speech":
                continue
            cap = r.get("caption")
            end = cap["display_end"] if cap else r["asr"]["audio_end"]
            if end > t_cut + 1e-9:
                continue  # spans the cutoff: never leak the rest of the sentence
            text = cap["text"] if cap else r["asr"]["text"]
            history.append({"sequence": seq, "kind": "utterance", "seat": r["speaker"]["seat"], "attribution": r["speaker"]["attribution"], "text": text})
        else:
            payload = dict(r["payload"])
            uid = payload.pop("utterance_id", None)
            if uid is not None:
                ref = utt_seq.get(uid)
                payload["utterance_sequence"] = ref if ref is not None and ref <= cutoff_sequence else None
            if isinstance(payload.get("holder"), dict):
                payload["holder"] = {k: v for k, v in payload["holder"].items() if k in ("kind", "seat")}
            history.append({"sequence": seq, "kind": "event", "type": r["type"], "payload": payload})

    return {
        "schema": "vbench.sample_x/1",
        "sample_id": sample_id,
        "draft": dataset != "accepted",
        "perspective": perspective,
        "cutoff": {"sequence": cutoff_sequence},
        "rules": {
            "player_count": rules["player_count"],
            "mission_team_sizes": rules["mission_team_sizes"],
            "proposal_limit": rules["proposal_limit"],
            "final_proposal_forced": rules["final_proposal_forced"],
            "fails_required": rules["fails_required"],
            "lady_of_the_lake": rules.get("lady_of_the_lake"),
            "role_composition": rules["role_composition"],
        },
        "seats": list(range(1, rules["player_count"] + 1)),
        "history": history,
    }


def x_bytes(x: dict) -> bytes:
    return (canonical_json(x) + "\n").encode("utf-8")


# ── timeline revision: X v2 ───────────────────────────────────────────────


def sample_id_v2(game_id: str, dataset: str, perspective: str, cutoff_sequence: int, run_id: str = "") -> str:
    # Sequences are per extraction run, so the run is part of the identity.
    return "x2-" + sha256_bytes(f"x2|{game_id}|{run_id}|{dataset}|{perspective}|{cutoff_sequence}".encode())[:16]


def build_x_v2(
    *, utterances: list[dict], events: list[dict], coverage: dict | None, boundary_decisions: list[dict],
    turns_cfg: dict | None, cutoff_sequence: int, rules: dict, sample_id: str, dataset: str,
    perspective: str = "public_observer",
) -> dict:
    """Sanitized projection of the public timeline at a cutoff.

    The prefix is cut on underlying segments/events *before* turn assembly, so a
    contribution that continues after the cutoff contributes only its already
    completed subtitle cards, and nothing about its future extent.
    """
    from .timeline import GAP_NOTE_X, TurnConfig, assemble, select_atoms

    check_perspective(perspective)
    live = (coverage or {}).get("live_game_interval")
    atoms, _ = select_atoms(utterances, events, dataset, live[1] if live else None)
    by_seq = {a["seq"]: a for a in atoms if a["kind"] != "excluded"}
    if cutoff_sequence not in by_seq:
        raise CutoffError(f"cutoff sequence {cutoff_sequence} is not an eligible {dataset} timeline record")
    t_cut = by_seq[cutoff_sequence]["public_at"]
    prefix = [a for a in atoms if a["seq"] <= cutoff_sequence and a["public_at"] <= t_cut + 1e-9]
    gaps = [g for g in (coverage or {}).get("gaps", []) if g["start"] <= t_cut]
    late = {k: g["gap_id"] for g in gaps for k in g["late_reported_event_keys"]}
    items, _ = assemble(prefix, gaps, {}, boundary_decisions, TurnConfig.from_dict(turns_cfg), late, until_public_at=t_cut)

    timeline = []
    for it in items:
        if it["kind"] == "speech":
            timeline.append({
                "kind": "speech",
                "turn": "t-" + sha256_bytes(it["turn_id"].encode())[:12],
                "part": it["part_index"],
                "continues_turn": it["continues_turn"],
                "seat": it["seat"],
                "speaker_uncertain": it["seat"] is None or bool({"speaker_transition", "overlap_suspected"} & set(it["flags"])) or it["speaker_basis"] not in ("label_stable", "reviewed"),
                "text": it["text"],
            })
        elif it["kind"] == "event":
            timeline.append({"kind": "event", "type": it["type"], "payload": it["payload"], "reported_late": it["reporting"]["status"] == "retrospective"})
        else:
            timeline.append({"kind": "coverage_gap", "note": GAP_NOTE_X})
    if timeline and timeline[-1]["kind"] == "speech":
        # Always set on a trailing speech part; says nothing about whether it continues.
        timeline[-1]["open_at_cutoff"] = True
    return {
        "schema": "vbench.sample_x/2",
        "sample_id": sample_id,
        "draft": dataset != "accepted",
        "perspective": perspective,
        "cutoff": {"sequence": cutoff_sequence},
        "rules": {k: rules[k] for k in ("player_count", "mission_team_sizes", "proposal_limit", "final_proposal_forced", "fails_required", "lady_of_the_lake", "role_composition") if k in rules},
        "seats": list(range(1, rules["player_count"] + 1)),
        "timeline": timeline,
    }
