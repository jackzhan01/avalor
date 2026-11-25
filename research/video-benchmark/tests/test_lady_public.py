"""Public check targets survive export; private check results never do."""

import copy

from test_agent_blocks import RULES, ev, mout, ts
from vbench.agent_pairs import build_document
from vbench.block_text import blocks_document, render_input
from vbench.blocks import block_accounting, build_blocks
from vbench.timeline import TurnConfig, assemble, select_atoms
from vbench.validate import agent_blocks_errors, record_errors


def evidence():
    return [ts(1, 2, 3, 5, [1, 2, 3, 5], 10, forced=True),
            mout(2, 2, "success", 0, 11),
            ev(3, "lady_transfer", {"mission": 2, "holder_seat": 5, "target_seat": 8}, 12)]


def test_check_is_public_but_its_private_result_is_rejected():
    event = evidence()[-1]
    assert not record_errors(event, "public_event", rules=RULES)
    for field in ("result", "announced", "role", "side"):
        contaminated = copy.deepcopy(event)
        contaminated["payload"][field] = "evil"
        assert record_errors(contaminated, "public_event", rules=RULES)


def test_check_is_rendered_without_opening_an_extra_round():
    atoms, _ = select_atoms([], evidence(), "accepted")
    items, _ = assemble(atoms, [], {}, [], TurnConfig(), {})
    blocks, _ = build_blocks(items, RULES)
    assert not block_accounting(blocks, items)
    doc = blocks_document(blocks, RULES)
    assert not agent_blocks_errors(doc)
    assert doc["blocks"][-1]["mission"] == 2
    assert "湖中仙女：5号查验8号" in render_input(doc)


def test_mission_cutoff_does_not_reveal_the_later_check():
    pub = {"utterances": [], "events": evidence(), "coverage": None, "decisions": [], "nicknames": []}
    cfg = {"rules": RULES, "interval": {"start": 0, "end": 20}}
    before = build_document(pub, cfg, "accepted", cutoff_sequence=2)
    after = build_document(pub, cfg, "accepted", cutoff_sequence=3)
    assert "5号查验8号" not in before["text"]
    assert "5号查验8号" in after["text"]
