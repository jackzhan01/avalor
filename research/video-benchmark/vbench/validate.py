"""Structural (JSON Schema) and semantic validation.

Schemas catch shape errors; the functions below catch the invariants that
shape alone cannot express (SPEC.md is the authority for both).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from .paths import SCHEMA_DIR

SCHEMA_NAMES = [
    "common", "layout", "ocr_observation", "caption_segment", "speaker_segment",
    "asr_segment", "utterance", "board_snapshot", "public_event", "correction",
    "review_item", "private_roles", "sample_x", "sample_y", "sequence_ledger",
    "evaluator_manifest", "pilot_config", "reference_review",
    # Timeline revision contracts.
    "game_record", "sample_x_v2", "sample_y_v2", "turn_boundary_correction", "coverage", "private_roster",
    # Agent-pair contracts (per-proposal blocks -> input/label files).
    "agent_blocks", "agent_label", "agent_pair_manifest", "agent_pair_audit",
]

# schema tag in a record -> schema file
TAG_TO_NAME = {f"vbench.{n}/1": n for n in SCHEMA_NAMES if n not in ("common", "sample_x_v2", "sample_y_v2", "private_roster")}
TAG_TO_NAME.update({"vbench.sample_x/2": "sample_x_v2", "vbench.sample_y/2": "sample_y_v2", "vbench.private_roster/2": "private_roster"})


class ValidationFailed(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("\n".join(errors[:20]) + (f"\n... {len(errors) - 20} more" if len(errors) > 20 else ""))
        self.errors = errors


@lru_cache(maxsize=None)
def _registry() -> Registry:
    resources = []
    for name in SCHEMA_NAMES:
        doc = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
        resources.append((doc["$id"], Resource.from_contents(doc)))
    return Registry().with_resources(resources)


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    doc = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(doc)
    return Draft202012Validator(doc, registry=_registry())


def schema_errors(name: str, obj: Any) -> list[str]:
    v = _validator(name)
    errs = sorted(v.iter_errors(obj), key=lambda e: list(e.absolute_path))
    return [f"{name}:{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errs]


def schema_name_for(obj: Any) -> str:
    tag = obj.get("schema") if isinstance(obj, dict) else None
    if tag not in TAG_TO_NAME:
        raise ValidationFailed([f"unknown or missing schema tag: {tag!r}"])
    return TAG_TO_NAME[tag]


# ── semantic checks ────────────────────────────────────────────────────────


def utterance_errors(u: dict) -> list[str]:
    errs: list[str] = []
    uid = u.get("utterance_id")
    cap = u.get("caption")
    asr = u.get("asr", {})
    if cap is not None and cap["display_end"] < cap["display_start"]:
        errs.append(f"{uid}: caption display_end before display_start")
    if cap is None and asr.get("text") is None:
        errs.append(f"{uid}: utterance has neither caption nor ASR text")
    if asr.get("mode") == "unavailable":
        if u["alignment"]["status"] != "asr_unavailable":
            errs.append(f"{uid}: ASR unavailable but alignment status is {u['alignment']['status']}")
        if "caption_only" not in u.get("flags", []):
            errs.append(f"{uid}: subtitle-only output must carry the caption_only flag")
    av = u.get("availability", {})
    if av.get("status") == "anchored":
        end = cap["display_end"] if cap else asr.get("audio_end")
        # Speech becomes public only once finished; an earlier anchor would leak
        # the rest of the sentence into a cutoff that splits it.
        if av.get("public_at") is None or end is None or av["public_at"] + 1e-6 < end:
            errs.append(f"{uid}: utterance public_at must be >= its end time")
    if u.get("review_status") == "accepted" and u.get("eligibility") == "unknown":
        errs.append(f"{uid}: accepted utterance must have a decided eligibility")
    if u.get("verbatim") is not None and not u["verbatim"].get("verified_by"):
        errs.append(f"{uid}: verbatim text without a verifier")
    return errs


def public_event_errors(e: dict, rules: dict | None = None) -> list[str]:
    errs: list[str] = []
    eid = e.get("event_id")
    t, p = e.get("type"), e.get("payload", {})
    av = e.get("availability", {})
    if av.get("status") == "anchored":
        if av.get("public_at") is None:
            errs.append(f"{eid}: anchored availability without public_at")
        if e.get("source") == "board" and not av.get("evidence_refs"):
            errs.append(f"{eid}: board-derived event anchored without evidence of the public reveal")
    elif av.get("public_at") is not None:
        errs.append(f"{eid}: unanchored availability must not carry public_at")
    if av.get("public_at") is not None and av["public_at"] + 1e-6 < 0:
        errs.append(f"{eid}: negative public_at")
    if t == "vote_outcome" and p.get("explicit") is not True:
        errs.append(f"{eid}: vote_outcome must come from explicit evidence, never a vote vector")
    if t == "vote_observation":
        for k in p.get("votes", {}):
            if rules and int(k) > rules.get("player_count", 10):
                errs.append(f"{eid}: vote for seat {k} beyond player_count")
    if t == "team_selection":
        seats = p.get("team_seats", [])
        if rules and p.get("mission"):
            sizes = rules.get("mission_team_sizes")
            if sizes and len(seats) != sizes[p["mission"] - 1] and "team_size_mismatch" not in e.get("flags", []):
                errs.append(f"{eid}: team size {len(seats)} != rule size without team_size_mismatch flag")
    if t == "mission_outcome":
        fc = p.get("fail_count")
        if fc is not None:
            if p["result"] == "fail" and fc == 0:
                errs.append(f"{eid}: failed mission with fail_count 0")
            if p["result"] == "success" and fc > 0:
                need = (rules or {}).get("fails_required", [1] * 5)[p["mission"] - 1]
                if fc >= need:
                    errs.append(f"{eid}: success with fail_count {fc} >= fails required {need}")
    if t in ("stance", "role_claim", "intended_team"):
        holder = p.get("holder", {})
        if holder.get("kind") == "speaker" and holder.get("seat") is None and e.get("review_status") == "accepted":
            errs.append(f"{eid}: accepted speaker-held statement without a seat")
        if holder.get("kind") == "unresolved" and e.get("review_status") == "accepted":
            errs.append(f"{eid}: unresolved quotation cannot be accepted as a stance; resolve holder first")
    return errs


def collection_errors(records: Iterable[dict], id_key: str) -> list[str]:
    errs = []
    records = list(records)
    ids = Counter(r.get(id_key) for r in records)
    errs += [f"duplicate {id_key}: {k}" for k, n in ids.items() if n > 1]
    seqs = Counter(r.get("sequence") for r in records if r.get("sequence") is not None)
    errs += [f"duplicate sequence {k}" for k, n in seqs.items() if n > 1]
    return errs


ROLE_SIDE = {
    "merlin": "good", "percival": "good", "loyal": "good",
    "morgana": "evil", "mordred": "evil", "assassin": "evil", "oberon": "evil", "minion": "evil",
}


def private_roles_errors(doc: dict) -> list[str]:
    errs: list[str] = []
    n = doc["player_count"]
    comp = doc["composition"]
    if sum(comp.values()) != n:
        errs.append(f"composition sums to {sum(comp.values())}, player_count is {n}")
    seats = [s["seat"] for s in doc["seats"]]
    dup = [k for k, c in Counter(seats).items() if c > 1]
    if dup:
        errs.append(f"duplicate seats: {dup}")
    if sorted(set(seats)) != list(range(1, n + 1)):
        errs.append(f"seats must cover exactly 1..{n}; got {sorted(set(seats))}")
    verified = Counter()
    for s in doc["seats"]:
        tag = f"seat {s['seat']}"
        if s["role"] == "unknown" and s["verification"] != "unknown":
            errs.append(f"{tag}: unknown role must have verification=unknown")
        if s["role"] != "unknown" and s["verification"] == "unknown":
            errs.append(f"{tag}: a role with verification=unknown is a guess; use role=unknown")
        if s["verification"] == "verified":
            if not s["evidence"]:
                errs.append(f"{tag}: verified without evidence")
            verified[s["role"]] += 1
        if s["role"] != "unknown" and s["role"] not in comp:
            errs.append(f"{tag}: role {s['role']} not in composition")
    for role, c in verified.items():
        if c > comp.get(role, 0):
            errs.append(f"verified {role} x{c} exceeds composition {comp.get(role, 0)}")
    if sum(verified.values()) == n and dict(verified) != comp:
        errs.append(f"fully verified roster {dict(verified)} != composition {comp}")
    return errs


FORBIDDEN_X_KEYS = {
    "title", "uploader", "url", "link", "bvid", "aid", "cid", "source", "source_id",
    "video_sha256", "sha256", "duration", "duration_s", "name", "names", "nickname",
    "label_text", "role", "roles", "side", "winner", "final_outcome", "thumbnail",
    "crop", "crop_path", "path", "file", "filename", "video_time", "video_start",
    "video_end", "display_start", "display_end", "public_at", "total_events",
    "total_utterances", "utterance_id", "event_id", "caption_segment_id", "evidence_refs",
}
FORBIDDEN_X_VALUE_PATTERNS = [
    re.compile(r"BV[0-9A-Za-z]{10}"),
    re.compile(r"https?://"),
    re.compile(r"\bsrc-[0-9a-f]{12}\b"),
    re.compile(r"\bgame-[0-9a-f]{10}\b"),
    re.compile(r"\.(mp4|m4a|png|jpg|jpeg|webp|flv)\b", re.I),
    re.compile(r"bilibili", re.I),
]


def sample_x_errors(doc: dict, extra_forbidden_strings: Iterable[str] = ()) -> list[str]:
    errs: list[str] = []
    extra = [s for s in extra_forbidden_strings if s]

    def walk(node: Any, path: str, allowed: frozenset = frozenset()) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if k in FORBIDDEN_X_KEYS and k not in allowed:
                    errs.append(f"X forbidden key {path}/{k}")
                child_allowed = frozenset()
                # A public role claim is speech ("我是派西"), not a label.
                if k == "payload" and node.get("type") == "role_claim":
                    child_allowed = frozenset({"role"})
                walk(v, f"{path}/{k}", child_allowed)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}/{i}")
        elif isinstance(node, str):
            for pat in FORBIDDEN_X_VALUE_PATTERNS:
                if pat.search(node):
                    errs.append(f"X forbidden value at {path}: matches {pat.pattern}")
            for s in extra:
                if s in node:
                    errs.append(f"X leaks evaluator-only string at {path}")

    walk(doc, "")
    seqs = [h["sequence"] for h in doc.get("history", [])]
    if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
        errs.append("X history not strictly ordered by sequence")
    if seqs and max(seqs) > doc["cutoff"]["sequence"]:
        errs.append("X history contains records after the cutoff sequence")
    return errs


def _leak_walk(node: Any, path: str, extra: list[str], errs: list[str], kind: str, allowed: frozenset = frozenset()) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k in FORBIDDEN_X_KEYS and k not in allowed:
                errs.append(f"{kind} forbidden key {path}/{k}")
            _leak_walk(v, f"{path}/{k}", extra, errs, kind)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _leak_walk(v, f"{path}/{i}", extra, errs, kind)
    elif isinstance(node, str):
        for pat in FORBIDDEN_X_VALUE_PATTERNS:
            if pat.search(node):
                errs.append(f"{kind} forbidden value at {path}: matches {pat.pattern}")
        for s in extra:
            if s in node:
                errs.append(f"{kind} leaks evaluator-only string at {path}")


def sample_x_v2_errors(doc: dict, extra_forbidden_strings: Iterable[str] = ()) -> list[str]:
    errs: list[str] = []
    _leak_walk(doc, "", [s for s in extra_forbidden_strings if s], errs, "X2")
    if any(it.get("kind") == "speech" and it.get("text", "") == "" for it in doc.get("timeline", [])):
        errs.append("X2 contains an empty speech item")
    return errs


# A block document carries no timing, ids or review state at all; these catch a
# field leaking in through a future change rather than through today's code.
FORBIDDEN_BLOCK_KEYS = FORBIDDEN_X_KEYS | {
    "turn_id", "item_id", "item_ids", "segment_id", "segment_ids", "source_sequence", "source_sequences",
    "sequence", "review_status", "text_origin", "machine_text", "asr_text", "flags", "audit", "context",
    "reporting", "availability_basis", "boundary_before", "observed_at", "start", "end", "public_at",
}


def agent_blocks_errors(doc: dict, extra_forbidden_strings: Iterable[str] = ()) -> list[str]:
    errs: list[str] = []
    _leak_walk(doc, "", [s for s in extra_forbidden_strings if s], errs, "blocks")
    seen = set()
    for b in doc.get("blocks", []):
        if b["block_id"] in seen:
            errs.append(f"duplicate block {b['block_id']}")
        seen.add(b["block_id"])
        for k in b:
            if k in FORBIDDEN_BLOCK_KEYS:
                errs.append(f"blocks/{b['block_id']}: forbidden key {k}")
        if b["outcome"] == "rejected" and (b["mission_ran"] or b["mission_result"] is not None):
            errs.append(f"{b['block_id']}: a rejected team cannot have a mission result")
        if b["forced"] and b["votes"] is not None:
            errs.append(f"{b['block_id']}: a forced team is not voted on")
        if b["mission_result"] is not None and not b["mission_ran"]:
            errs.append(f"{b['block_id']}: mission result without a team that ran")
        v = b["votes"]
        if v is not None:
            lists = [v["approve"], v["reject"], v["unclear"], v["unrecorded"]]
            allseats = [s for lst in lists for s in lst]
            if len(allseats) != len(set(allseats)):
                errs.append(f"{b['block_id']}: a seat appears in two vote groups")
    return errs


# Anything that would betray the audit layer inside the text actually sent.
FORBIDDEN_INPUT_PATTERNS = [
    re.compile(r"\butt-[0-9a-f]{6}"),
    re.compile(r"\bevt-[0-9a-f]{6}"),
    re.compile(r"\b(turn|part|seq|rec|gap|ocr|asr|spk|brd|cor)-[0-9a-f]{6}"),
    re.compile(r"\b\d{1,2}:\d{2}[.:]\d{2}"),
    re.compile(r"vbench\."),
    re.compile(r"sha256", re.I),
    re.compile(r"\bOCR\b|\bASR\b"),
    re.compile(r"review_status|sequence|schema", re.I),
] + FORBIDDEN_X_VALUE_PATTERNS


def input_text_errors(text: str, extra_forbidden_strings: Iterable[str] = ()) -> list[str]:
    """The rendered document must read as a game record, not as an audit artifact."""
    errs = []
    for pat in FORBIDDEN_INPUT_PATTERNS:
        m = pat.search(text)
        if m:
            errs.append(f"input text matches {pat.pattern} at {m.start()}: {m.group(0)!r}")
    for s in extra_forbidden_strings:
        if s and s in text:
            errs.append("input text contains an evaluator-only string")
    return errs


def split_isolation_errors(manifest: dict) -> list[str]:
    errs: list[str] = []
    game_split = {g["game_id"]: (g["group_id"], g["split"]) for g in manifest["games"]}
    group_split: dict[str, set] = {}
    for g in manifest["games"]:
        group_split.setdefault(g["group_id"], set()).add(g["split"])
    for grp, splits in group_split.items():
        if len(splits) > 1:
            errs.append(f"group {grp} spans splits {sorted(splits)}")
    for s in manifest["samples"]:
        if s["game_id"] not in game_split:
            errs.append(f"sample {s['sample_id']} references unknown game")
            continue
        grp, split = game_split[s["game_id"]]
        if (s["group_id"], s["split"]) != (grp, split):
            errs.append(f"sample {s['sample_id']} split/group differs from its game")
    return errs


def ledger_errors(ledger: dict) -> list[str]:
    errs = []
    seqs = [e["sequence"] for e in ledger["entries"]]
    if len(set(seqs)) != len(seqs):
        errs.append("ledger reuses a sequence number")
    if seqs and max(seqs) >= ledger["next_sequence"]:
        errs.append("ledger next_sequence not beyond allocated sequences")
    ids = Counter((e["record_kind"], e["record_id"]) for e in ledger["entries"])
    errs += [f"ledger allocates record twice: {k}" for k, n in ids.items() if n > 1]
    return errs


def corrections_errors(rows: list[dict]) -> list[str]:
    errs = []
    revs = [r["revision"] for r in rows]
    if revs != sorted(revs) or len(set(revs)) != len(revs):
        errs.append("correction revisions must be strictly increasing")
    ids = Counter(r["correction_id"] for r in rows)
    errs += [f"duplicate correction_id {k}" for k, n in ids.items() if n > 1]
    return errs


SEMANTIC = {
    "utterance": lambda o, ctx: utterance_errors(o),
    "public_event": lambda o, ctx: public_event_errors(o, ctx.get("rules")),
    "private_roles": lambda o, ctx: private_roles_errors(o),
    "sample_x": lambda o, ctx: sample_x_errors(o, ctx.get("forbidden_strings", ())),
    "sample_x_v2": lambda o, ctx: sample_x_v2_errors(o, ctx.get("forbidden_strings", ())),
    "agent_blocks": lambda o, ctx: agent_blocks_errors(o, ctx.get("forbidden_strings", ())),
    "evaluator_manifest": lambda o, ctx: split_isolation_errors(o),
    "sequence_ledger": lambda o, ctx: ledger_errors(o),
}


def record_errors(obj: dict, name: str | None = None, **ctx: Any) -> list[str]:
    try:
        name = name or schema_name_for(obj)
    except ValidationFailed as e:
        return e.errors
    errs = schema_errors(name, obj)
    if not errs and name in SEMANTIC:
        errs += SEMANTIC[name](obj, ctx)
    return errs


def require_valid(obj: dict, name: str | None = None, **ctx: Any) -> None:
    errs = record_errors(obj, name, **ctx)
    if errs:
        raise ValidationFailed(errs)


def validate_path(path: Path, **ctx: Any) -> tuple[int, list[str]]:
    """Validate a .json or .jsonl artifact; returns (records checked, errors)."""
    from .util import read_json, read_jsonl

    if path.suffix == ".jsonl":
        rows = read_jsonl(path)
        errs: list[str] = []
        for i, r in enumerate(rows):
            errs += [f"line {i + 1}: {m}" for m in record_errors(r, **ctx)]
        if rows:
            tag = rows[0].get("schema")
            if tag == "vbench.correction/1":
                errs += corrections_errors(rows)
            id_key = {"vbench.utterance/1": "utterance_id", "vbench.public_event/1": "event_id"}.get(tag)
            if id_key:
                errs += collection_errors(rows, id_key)
        return len(rows), errs
    obj = read_json(path)
    return 1, record_errors(obj, **ctx)
