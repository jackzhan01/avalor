"""Per-proposal blocks: the model-facing view of a game.

One block = one round of team building ("第 M 轮任务 · 第 N 次组队"): the speech
that happened while that team was being discussed, then the objective outcome of
that team (leader, team, votes, result, and — only if that team actually ran —
the mission result).

Two properties this module exists to guarantee:

* **Forward-only block numbering.** Which block a line of speech belongs to is
  decided from records that are already public at that moment (the previous
  vote or mission result), never from the team selection that follows it. A
  prefix of the record therefore produces exactly the blocks of the full record,
  truncated — assembling at a cutoff cannot pull a later team, tally or mission
  result into an earlier block.
* **No new facts.** Blocks only regroup `assemble()` output. Text is never
  rewritten, reordered or summarised, and nothing is inferred from a partial
  tally: an explicit board result is the only source of 车过了/车被否.

The board row's own (mission, proposal_index) is compared against the derived
numbering; disagreements are recorded rather than silently resolved.
"""

from __future__ import annotations

from .timeline import OBJECTIVE_EVENT_TYPES, TEXT_JOIN

VOTE_VALUES = ("approve", "reject", "unknown")


def _new_block(mission: int, attempt: int, rules: dict) -> dict:
    limit = rules.get("proposal_limit")
    forced = bool(rules.get("final_proposal_forced")) and limit is not None and attempt >= limit
    return {
        "block_id": f"b{mission}-{attempt}",
        "mission": mission,
        "attempt": attempt,
        "forced": forced,
        "forced_basis": "rules: last allowed proposal of the round" if forced else "rules: not the last allowed proposal",
        "speech": [],
        "gap_inside": False,
        "leader_seat": None,
        "team_seats": None,
        "votes": None,
        "tally_text": None,
        "outcome": None,
        "mission_ran": False,
        "mission_result": None,
        "fail_count": None,
        "audit": {"items": [], "events": [], "gaps": [], "conflicts": []},
    }


def _append_speech(block: dict, item: dict) -> None:
    """Continue the open paragraph when this is the same contribution, else start one."""
    para = block["speech"][-1] if block["speech"] else None
    if para is not None and para["turn_id"] == item["turn_id"] and para["seat"] == item["seat"]:
        para["text"] += TEXT_JOIN + item["text"]
        para["item_ids"].append(item["item_id"])
        para["segment_ids"] += [s["segment_id"] for s in item["segments"]]
        return
    block["speech"].append({
        "seat": item["seat"],
        "text": item["text"],
        "turn_id": item["turn_id"],
        "item_ids": [item["item_id"]],
        "segment_ids": [s["segment_id"] for s in item["segments"]],
    })


def _votes_view(payload: dict, player_count: int) -> dict:
    """Seat lists per vote value. A missing key is 'not recorded', not 'unclear'."""
    votes = payload.get("votes") or {}
    seen = {int(s) for s in votes}
    return {
        "approve": sorted(int(s) for s, v in votes.items() if v == "approve"),
        "reject": sorted(int(s) for s, v in votes.items() if v == "reject"),
        "unclear": sorted(int(s) for s, v in votes.items() if v == "unknown"),
        "unrecorded": sorted(set(range(1, player_count + 1)) - seen),
    }


def build_blocks(items: list[dict], rules: dict) -> tuple[list[dict], dict]:
    """Group an assembled timeline into per-proposal blocks. Forward-only."""
    player_count = rules.get("player_count", 10)
    limit = rules.get("proposal_limit")
    blocks: list[dict] = [_new_block(1, 1, rules)]
    stats: dict = {"conflicts": [], "unplaced_events": []}

    def cur() -> dict:
        return blocks[-1]

    def note(block: dict, entry: dict) -> None:
        stats["conflicts"].append(entry)
        block["audit"]["conflicts"].append(entry)

    for it in items:
        if it["kind"] == "coverage_gap":
            cur()["gap_inside"] = True
            cur()["audit"]["gaps"].append(it["gap_id"])
            continue
        if it["kind"] == "speech":
            _append_speech(cur(), it)
            cur()["audit"]["items"].append({"item_id": it["item_id"], "source_sequences": [s["source_sequence"] for s in it["segments"]]})
            continue
        if it["type"] not in OBJECTIVE_EVENT_TYPES:
            stats["unplaced_events"].append({"event_id": it["event_id"], "reason": f"{it['type']} is not an objective game event"})
            continue

        p = it["payload"]
        m, a = p.get("mission"), p.get("proposal_index")
        target = cur()
        if it["type"] == "mission_outcome":
            hit = next((b for b in blocks if b["mission"] == m and b["mission_ran"]), None)
            if hit is None:
                note(target, {"event_id": it["event_id"], "type": it["type"], "mission": m,
                              "resolution": "no earlier block ran a team for this mission; kept in the open block"})
            target = hit or target
        elif m is not None and a is not None and (m, a) != (target["mission"], target["attempt"]):
            # A board row that names its own proposal belongs to that proposal,
            # not to whatever discussion happens to be running when it appears.
            hit = next((b for b in blocks if b["mission"] == m and b["attempt"] == a), None)
            ahead = (m, a) > (target["mission"], target["attempt"])
            if hit is None and ahead and target is cur():
                # Attempts whose discussion the edit dropped: the board row is the
                # only witness of which attempt this is, so the open block takes
                # its number. The gap that swallowed the others stays visible in
                # `speech_recorded`.
                resolution = "open block renumbered to the board row"
            else:
                resolution = "moved into the block the board row names" if hit else "board row names a block that was never opened; kept in the open block"
            note(target, {"event_id": it["event_id"], "type": it["type"], "board": [m, a],
                          "derived": [target["mission"], target["attempt"]], "resolution": resolution})
            if resolution == "open block renumbered to the board row":
                target.update(mission=m, attempt=a, block_id=f"b{m}-{a}",
                              forced=bool(rules.get("final_proposal_forced")) and limit is not None and a >= limit,
                              forced_basis="rules: last allowed proposal of the round (numbered from the board row)")
            else:
                target = hit or target
        target["audit"]["events"].append({"event_id": it["event_id"], "type": it["type"], "source_sequence": it["source_sequence"]})
        was_open = target is cur()

        if it["type"] == "team_selection":
            target["leader_seat"] = p.get("leader_seat")
            target["team_seats"] = list(p.get("team_seats") or [])
            if p.get("forced") is not None and bool(p["forced"]) != target["forced"]:
                note(target, {"event_id": it["event_id"], "type": "forced_flag", "board": bool(p["forced"]),
                              "derived": target["forced"], "resolution": "board row is authoritative"})
                target["forced"] = bool(p["forced"])
                target["forced_basis"] = "board row"
            if target["forced"]:
                target["mission_ran"] = True  # a forced team is not voted on; it runs
        elif it["type"] == "vote_observation":
            target["votes"] = _votes_view(p, player_count)
        elif it["type"] == "vote_outcome":
            target["outcome"] = p.get("result")
            target["tally_text"] = p.get("tally_text")
            if p.get("result") == "passed":
                target["mission_ran"] = True
            elif p.get("result") == "rejected" and was_open:
                if limit is not None and target["attempt"] >= limit:
                    note(target, {"event_id": it["event_id"], "type": "vote_after_limit",
                                  "resolution": "a vote is recorded on the last allowed proposal; numbering stays put"})
                else:
                    blocks.append(_new_block(target["mission"], target["attempt"] + 1, rules))
        elif it["type"] == "mission_outcome":
            target["mission_result"] = p.get("result")
            target["fail_count"] = p.get("fail_count")
            if was_open:
                blocks.append(_new_block(target["mission"] + 1, 1, rules))

    return [b for b in blocks if _has_content(b)], stats


def _has_content(block: dict) -> bool:
    return bool(block["speech"] or block["gap_inside"] or block["team_seats"] or block["votes"]
                or block["leader_seat"] is not None or block["outcome"] or block["mission_result"])


def block_accounting(blocks: list[dict], items: list[dict]) -> list[str]:
    """Every speech item and objective event appears in exactly one block, unchanged."""
    errs = []
    want_items = [it["item_id"] for it in items if it["kind"] == "speech"]
    seen_items = [i for b in blocks for p in b["speech"] for i in p["item_ids"]]
    if sorted(want_items) != sorted(seen_items):
        missing = set(want_items) - set(seen_items)
        extra = set(seen_items) - set(want_items)
        errs.append(f"speech items: missing {len(missing)}, unexpected {len(extra)}")
    if len(seen_items) != len(set(seen_items)):
        errs.append("a speech item appears in more than one block")
    want_ev = [it["event_id"] for it in items if it["kind"] == "event" and it["type"] in OBJECTIVE_EVENT_TYPES]
    seen_ev = [e["event_id"] for b in blocks for e in b["audit"]["events"]]
    if sorted(want_ev) != sorted(seen_ev):
        errs.append(f"objective events: expected {len(want_ev)}, placed {len(seen_ev)}")
    if len(seen_ev) != len(set(seen_ev)):
        errs.append("an objective event appears in more than one block")
    by_item = {it["item_id"]: it for it in items if it["kind"] == "speech"}
    for b in blocks:
        for p in b["speech"]:
            joined = TEXT_JOIN.join(by_item[i]["text"] for i in p["item_ids"] if i in by_item)
            if joined != p["text"]:
                errs.append(f"{b['block_id']}: paragraph text is not the joined original speech")
            if len({by_item[i]["seat"] for i in p["item_ids"] if i in by_item}) > 1:
                errs.append(f"{b['block_id']}: paragraph mixes speakers")
    return errs
