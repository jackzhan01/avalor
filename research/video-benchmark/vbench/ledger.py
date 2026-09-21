"""Sequence ledger: append-only, never renumbered, never reused.

Allocation is an explicit step run after review, because board-derived events
only get a position once a reviewer anchors their public availability. A
record whose position turns out to be earlier than already-numbered records
still gets a *new, larger* number and is marked out_of_sequence; exports then
include it no earlier than its own number, i.e. late but never early.
"""

from __future__ import annotations

from pathlib import Path

from .util import read_json, write_json
from .validate import ValidationFailed, ledger_errors, schema_errors

# Logical order inside one reveal moment: a team is selected before it is voted
# on, votes precede the announced outcome, which precedes the mission. This is
# game structure, not timing inference.
TYPE_RANK = {
    "utterance": 0, "team_selection": 1, "vote_observation": 2, "vote_outcome": 3,
    "mission_outcome": 4, "role_claim": 5, "stance": 5, "intended_team": 5, "lady_announcement": 5,
}


def empty_ledger() -> dict:
    return {"schema": "vbench.sequence_ledger/1", "next_sequence": 1, "entries": []}


def load_ledger(path: Path) -> dict:
    return read_json(path) if path.exists() else empty_ledger()


def save_ledger(path: Path, ledger: dict) -> None:
    errs = schema_errors("sequence_ledger", ledger) or ledger_errors(ledger)
    if errs:
        raise ValidationFailed(errs)
    write_json(path, ledger)


def order_key(kind: str, rec: dict) -> list:
    rank = TYPE_RANK["utterance"] if kind == "utterance" else TYPE_RANK[rec["type"]]
    return [float(rec["availability"]["public_at"]), rank, rec["utterance_id" if kind == "utterance" else "event_id"]]


def allocate(ledger: dict, records: list[tuple[str, dict]]) -> dict:
    allocated = {(e["record_kind"], e["record_id"]) for e in ledger["entries"]}
    round_no = max((e["allocation_round"] for e in ledger["entries"]), default=0) + 1
    new = []
    for kind, rec in records:
        rid = rec["utterance_id" if kind == "utterance" else "event_id"]
        if (kind, rid) in allocated:
            continue
        if rec.get("review_status") == "rejected" or rec["availability"]["status"] != "anchored":
            continue
        new.append((order_key(kind, rec), kind, rid))
    new.sort()
    prior = list(ledger["entries"])
    for key, kind, rid in new:
        later = [e for e in prior if tuple(e["order_key"][:2]) > tuple(key[:2])]
        ties = [e["record_id"] for e in prior + ledger["entries"][len(prior):] if e["order_key"][:2] == key[:2]]
        if later:
            ordering = {"status": "out_of_sequence", "belongs_before_sequence": min(e["sequence"] for e in later)}
        elif ties:
            ordering = {"status": "unresolved", "tied_with": ties}
        else:
            ordering = {"status": "in_sequence"}
        ledger["entries"].append({
            "sequence": ledger["next_sequence"],
            "record_kind": kind,
            "record_id": rid,
            "order_key": key,
            "ordering": ordering,
            "allocation_round": round_no,
        })
        ledger["next_sequence"] += 1
    return ledger


def attach(ledger: dict, kind: str, rows: list[dict]) -> list[dict]:
    idx = {e["record_id"]: e for e in ledger["entries"] if e["record_kind"] == kind}
    id_key = "utterance_id" if kind == "utterance" else "event_id"
    out = []
    for r in rows:
        e = idx.get(r[id_key])
        r = dict(r)
        r["sequence"] = e["sequence"] if e else None
        r["ordering"] = e["ordering"] if e else {"status": "unallocated"}
        out.append(r)
    return sorted(out, key=lambda r: (r["sequence"] is None, r["sequence"] or 0, r[id_key]))
