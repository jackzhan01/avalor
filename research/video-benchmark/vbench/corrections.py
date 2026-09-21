"""Append-only human corrections, applied on top of immutable machine records.

Machine files are never edited. A correction names the record it targets and
the hash of the content the reviewer looked at; if re-extraction changed or
removed that record the correction is reported stale instead of being applied
to something the reviewer never saw. A later correction to a field that
already has an effective correction must say which one it supersedes.
"""

from __future__ import annotations

import copy
from pathlib import Path

from .util import append_jsonl, read_jsonl, sha256_json, short_id
from .validate import ValidationFailed, corrections_errors, record_errors

ID_KEY = {"utterance": "utterance_id", "public_event": "event_id"}
SCHEMA_NAME = {"utterance": "utterance", "public_event": "public_event"}

SETTABLE = {
    "utterance": ("caption.text", "speaker.seat", "speaker.attribution", "eligibility", "flags", "verbatim", "asr.text"),
    "public_event": ("payload", "flags", "interpretations"),
}


def content_sha(record: dict) -> str:
    return sha256_json(record)


def _path_allowed(kind: str, path: str) -> bool:
    return any(path == p or path.startswith(p + ".") for p in SETTABLE[kind])


def make_correction(
    existing: list[dict], *, kind: str, target: dict | None, op: str, path: str | None = None, value=None,
    reviewer: str, note: str, supersedes: str | None = None, evidence_refs: list[dict] | None = None,
    target_id: str | None = None,
) -> dict:
    revision = max((c["revision"] for c in existing), default=0) + 1
    tid = target[ID_KEY[kind]] if target is not None else target_id
    row = {
        "schema": "vbench.correction/1",
        "correction_id": short_id("cor", revision, kind, tid, op, path, value),
        "revision": revision,
        "reviewer": reviewer,
        "target": {"kind": kind, "id": tid, "content_sha256": None if op == "add" else content_sha(target)},
        "op": op,
        "path": path,
        "value": value,
        "note": note,
        "supersedes": supersedes,
    }
    if evidence_refs:
        row["evidence_refs"] = evidence_refs
    return row


def append_corrections(path: Path, new_rows: list[dict]) -> None:
    existing = read_jsonl(path)
    errs: list[str] = []
    for r in new_rows:
        errs += record_errors(r, "correction")
        if r.get("op") == "set" and not _path_allowed(r["target"]["kind"], r["path"]):
            errs.append(f"{r['correction_id']}: path {r['path']} is not correctable")
    errs += corrections_errors(existing + new_rows)
    if errs:
        raise ValidationFailed(errs)
    append_jsonl(path, new_rows)


def _set_path(obj: dict, path: str, value) -> None:
    parts = path.split(".")
    cur = obj
    for p in parts[:-1]:
        cur = cur[p]
    cur[parts[-1]] = value


def _get_path(obj: dict, path: str):
    cur = obj
    for p in path.split("."):
        cur = cur[p]
    return cur


def apply_corrections(machine: dict[str, list[dict]], corrections: list[dict], rules: dict | None = None, presorted: bool = False) -> tuple[dict[str, list[dict]], dict]:
    views: dict[str, dict[str, dict]] = {}
    base_sha: dict[tuple[str, str], str] = {}
    for kind, rows in machine.items():
        views[kind] = {}
        for r in rows:
            rid = r[ID_KEY[kind]]
            base_sha[(kind, rid)] = content_sha(r)
            v = copy.deepcopy(r)
            v["origin"] = "machine"
            v["machine_content_sha256"] = base_sha[(kind, rid)]
            v["applied_corrections"] = []
            views[kind][rid] = v

    report = {"applied": [], "stale": [], "conflicts": [], "invalid_after_apply": []}
    effective: dict[tuple, str] = {}
    # presorted: caller concatenated several append-only files in application order.
    for c in (corrections if presorted else sorted(corrections, key=lambda c: c["revision"])):
        kind, tid = c["target"]["kind"], c["target"]["id"]
        field_key = (kind, tid, {"accept": "review_status", "reject": "review_status", "anchor": "availability", "add": "<record>"}.get(c["op"], c["path"]))
        prior = effective.get(field_key)
        if prior is not None and c.get("supersedes") != prior:
            report["conflicts"].append({"correction_id": c["correction_id"], "reason": f"field already corrected by {prior}; set supersedes to replace it"})
            continue
        if c["op"] == "add":
            if tid in views[kind]:
                report["conflicts"].append({"correction_id": c["correction_id"], "reason": "record id already exists"})
                continue
            rec = copy.deepcopy(c["value"])
            rec["origin"] = "correction"
            rec["applied_corrections"] = [c["correction_id"]]
            base_sha[(kind, tid)] = content_sha(c["value"])
            views[kind][tid] = rec
            effective[field_key] = c["correction_id"]
            report["applied"].append(c["correction_id"])
            continue
        if tid not in views[kind]:
            report["stale"].append({"correction_id": c["correction_id"], "reason": "stale:missing_target", "target": tid})
            continue
        if c["target"]["content_sha256"] != base_sha[(kind, tid)]:
            report["stale"].append({"correction_id": c["correction_id"], "reason": "stale:content_changed", "target": tid})
            continue
        v = views[kind][tid]
        if c["op"] == "accept":
            v["review_status"] = "accepted"
        elif c["op"] == "reject":
            v["review_status"] = "rejected"
        elif c["op"] == "anchor":
            v["availability"] = {
                "status": "anchored",
                "public_at": c["value"]["public_at"],
                "basis": c["value"]["basis"],
                "evidence_refs": c["value"].get("evidence_refs", []) + [{"kind": "correction", "id": c["correction_id"]}],
            }
        elif c["op"] == "set":
            if not _path_allowed(kind, c["path"]):
                report["conflicts"].append({"correction_id": c["correction_id"], "reason": f"path {c['path']} not correctable"})
                continue
            if c["path"] == "caption.text" and v.get("caption"):
                old = v["caption"]["text"]
                if old not in v["caption"]["alternatives"] and old != c["value"]:
                    v["caption"]["alternatives"] = sorted(v["caption"]["alternatives"] + [old])
            _set_path(v, c["path"], copy.deepcopy(c["value"]))
            if c["path"] == "speaker.seat":
                v["speaker"]["attribution"] = "reviewed"
        v["applied_corrections"].append(c["correction_id"])
        effective[field_key] = c["correction_id"]
        report["applied"].append(c["correction_id"])

    out: dict[str, list[dict]] = {}
    for kind, recs in views.items():
        rows = []
        for rid, v in recs.items():
            errs = record_errors(v, SCHEMA_NAME[kind], rules=rules)
            if errs:
                report["invalid_after_apply"].append({"id": rid, "errors": errs[:5]})
                v = dict(v, review_status="needs_review") if v.get("review_status") == "accepted" else v
            rows.append(v)
        out[kind] = rows
    return out, report
