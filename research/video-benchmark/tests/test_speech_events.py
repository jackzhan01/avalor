"""Bounded statement parser: quotation attribution, hedges, negation, claims."""

from vbench.speech_events import extract_statements
from vbench.validate import record_errors

PROV = {"stage": "speech_events", "stage_version": "1", "tool": "rule-parser"}


def _utt(text, seat=6, uid="utt-00000000000000a1"):
    return {
        "utterance_id": uid,
        "caption": {"text": text, "display_start": 10.0, "display_end": 12.0},
        "speaker": {"seat": seat},
        "availability": {"status": "anchored", "public_at": 12.0},
        "review_status": "machine_candidate",
    }


def _stances(text, seat=6):
    return [e for e in extract_statements([_utt(text, seat)], "a" * 64, PROV) if e["type"] == "stance"]


def test_quoted_accusation_is_not_attributed_to_the_speaker():
    evs = _stances("然后点出了十号他可能是张莫甘娜")
    assert evs, "the accusation itself is still a candidate"
    for e in evs:
        assert e["payload"]["target_seat"] == 10
        assert e["payload"]["holder"]["kind"] == "unresolved"
        assert e["payload"]["holder"]["seat"] is None
        assert "unresolved_quote" in e["flags"]


def test_unresolved_quote_cannot_be_accepted_as_a_confident_stance():
    e = _stances("然后点出了十号他可能是张莫甘娜")[0]
    e["review_status"] = "accepted"
    errs = record_errors(e, "public_event")
    assert any("unresolved quotation" in m for m in errs)


def test_first_person_hedged_positive_stance():
    evs = _stances("可我觉得5号可能干净一点啊", seat=7)
    assert len(evs) == 1
    p = evs[0]["payload"]
    assert (p["holder"]["kind"], p["holder"]["seat"], p["target_seat"], p["polarity"], p["hedged"], p["negated"]) == ("speaker", 7, 5, "positive", True, False)


def test_negation_is_preserved_not_flipped():
    evs = _stances("但是我觉得不把2号打死", seat=9)
    assert len(evs) == 1
    p = evs[0]["payload"]
    assert p["target_seat"] == 2 and p["polarity"] == "negative" and p["negated"] is True
    assert "negated" in evs[0]["flags"]


def test_role_claim_and_denial_are_speech_not_truth():
    evs = extract_statements([_utt("我是忠臣啊过了", seat=2, uid="utt-00000000000000b1"), _utt("我不是派西", seat=4, uid="utt-00000000000000b2")], "a" * 64, PROV)
    claims = sorted((e["payload"]["holder"]["seat"], e["payload"]["role"], e["payload"]["claimed"]) for e in evs if e["type"] == "role_claim")
    assert claims == [(2, "loyal", True), (4, "percival", False)]
    for e in evs:
        assert "truth" not in e["payload"]
        assert e["review_status"] == "needs_review"


def test_statement_without_marker_defaults_to_speaker_but_is_flagged():
    evs = _stances("专门盯着这个2号打啊", seat=6)
    assert evs and all("no_first_person_marker" in e["flags"] for e in evs)


def test_intended_team_is_a_speech_act_with_holder():
    evs = [e for e in extract_statements([_utt("我先点个车2345", seat=3)], "a" * 64, PROV) if e["type"] == "intended_team"]
    assert len(evs) == 1 and evs[0]["payload"]["team_seats"] == [2, 3, 4, 5]
    assert evs[0]["payload"]["holder"]["seat"] == 3
