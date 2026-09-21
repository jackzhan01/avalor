"""Utterance candidates: caption + speaker attribution + ASR cross-check.

Disagreement is data. Neither side is edited toward the other; the alignment
block only records how far apart they are and why that matters (numerals,
negations).
"""

from __future__ import annotations

from difflib import SequenceMatcher

from .captions import attribute_speaker
from .textnorm import canonical_numerals, cer, negation_count, numerals_in, normalize_for_compare
from .util import short_id

UTTERANCES_STAGE_VERSION = "1"


def _assign_words(captions: list[dict], asr_segments: list[dict], pad: float) -> tuple[dict[str, list[tuple[dict, str]]], list[tuple[dict, str]]]:
    """Assign ASR words to captions by text alignment first, time second.

    Whisper word times and editor caption times each drift by a few hundred ms,
    so pure time overlap hands boundary words to the neighbouring caption and
    manufactures disagreement. A monotonic character alignment between the
    caption stream and the ASR stream anchors most words; unmatched words go to
    the nearer of their matched neighbours' captions, or stay unassigned when
    they are far from both (candidate unsubtitled speech).
    """
    caps = sorted(captions, key=lambda c: c["display_start"])
    by_cap: dict[str, list[tuple[dict, str]]] = {c["caption_segment_id"]: [] for c in caps}
    words = [(w, seg["asr_segment_id"]) for seg in asr_segments for w in seg["words"]]
    words.sort(key=lambda x: x[0]["start"])
    if not caps:
        return by_cap, words

    cap_chars, cap_owner = [], []
    for ci, c in enumerate(caps):
        for ch in canonical_numerals(normalize_for_compare(c["text"])):
            cap_chars.append(ch)
            cap_owner.append(ci)
    asr_chars, asr_owner = [], []
    for wi, (w, _) in enumerate(words):
        for ch in canonical_numerals(normalize_for_compare(w["word"])):
            asr_chars.append(ch)
            asr_owner.append(wi)

    def near(ci: int, w: dict, slack: float) -> bool:
        c = caps[ci]
        return c["display_start"] - slack <= (w["start"] + w["end"]) / 2 <= c["display_end"] + slack

    votes: dict[int, dict[int, int]] = {}
    sm = SequenceMatcher(None, "".join(cap_chars), "".join(asr_chars), autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            ci, wi = cap_owner[blk.a + k], asr_owner[blk.b + k]
            # A textual match far away in time is a coincidence, not an alignment.
            if near(ci, words[wi][0], 3.0):
                votes.setdefault(wi, {}).setdefault(ci, 0)
                votes[wi][ci] += 1
    assigned: dict[int, int] = {wi: max(v.items(), key=lambda kv: kv[1])[0] for wi, v in votes.items()}

    matched_idx = sorted(assigned)
    unassigned: list[tuple[dict, str]] = []
    for wi, (w, sid) in enumerate(words):
        if wi in assigned:
            continue
        prev = max((m for m in matched_idx if m < wi), default=None)
        nxt = min((m for m in matched_idx if m > wi), default=None)
        options = {assigned[m] for m in (prev, nxt) if m is not None}
        options |= {ci for ci in range(len(caps)) if near(ci, w, pad)}
        mid = (w["start"] + w["end"]) / 2

        def dist(ci: int) -> float:
            c = caps[ci]
            return 0.0 if c["display_start"] <= mid <= c["display_end"] else min(abs(mid - c["display_start"]), abs(mid - c["display_end"]))

        best = min(options, key=dist, default=None)
        if best is None or dist(best) > 1.0:
            unassigned.append((w, sid))
        else:
            assigned[wi] = best
    for wi, ci in sorted(assigned.items()):
        by_cap[caps[ci]["caption_segment_id"]].append(words[wi])
    return by_cap, unassigned


def build_utterances(
    captions: list[dict],
    speakers: list[dict],
    asr_segments: list[dict] | None,
    asr_mode: str,
    source_sha: str,
    provenance: dict,
    agree_cer: float = 0.15,
    minor_cer: float = 0.4,
    pad_s: float = 0.3,
) -> list[dict]:
    out: list[dict] = []
    asr_available = asr_segments is not None
    by_cap, unassigned = _assign_words(captions, asr_segments or [], pad_s) if asr_available else ({}, [])

    for c in sorted(captions, key=lambda c: c["display_start"]):
        spk = attribute_speaker(speakers, c["display_start"], c["display_end"])
        flags = [f for f in c["flags"] if f in ("guard_mismatch", "short", "low_score")]
        if spk["attribution"] == "label_transition":
            flags.append("label_transition")
        if asr_available:
            words = by_cap.get(c["caption_segment_id"], [])
            asr_text = "".join(w["word"] for w, _ in words) if words else None
            refs = sorted({sid for _, sid in words})
            if words:
                rate = cer(asr_text, c["text"], canonical_digits=True)
                reasons = []
                if sorted(numerals_in(asr_text)) != sorted(numerals_in(c["text"])):
                    reasons.append("numeral_mismatch")
                    flags.append("uncertain_numeral")
                if negation_count(asr_text) != negation_count(c["text"]):
                    reasons.append("negation_mismatch")
                    flags.append("uncertain_negation")
                ln_a, ln_c = len(normalize_for_compare(asr_text)), len(normalize_for_compare(c["text"]))
                if ln_c and (ln_a > 2 * ln_c + 4):
                    # Much more audio than caption: likely overlapping or unsubtitled speech.
                    reasons.append("length_mismatch")
                    flags.append("overlap_suspected")
                status = "agree" if rate <= agree_cer else "minor_diff" if rate <= minor_cer else "disagree"
                alignment = {"status": status, "cer": round(rate, 4), "reasons": reasons}
                asr = {
                    "mode": asr_mode,
                    "text": asr_text,
                    "audio_start": min(w["start"] for w, _ in words),
                    "audio_end": max(w["end"] for w, _ in words),
                    "segment_refs": refs,
                    "min_word_probability": round(min((w["probability"] or 0) for w, _ in words), 4),
                }
            else:
                alignment = {"status": "no_asr_overlap", "cer": None, "reasons": []}
                asr = {"mode": asr_mode, "text": None, "audio_start": None, "audio_end": None, "segment_refs": [], "min_word_probability": None}
        else:
            flags.append("caption_only")
            alignment = {"status": "asr_unavailable", "cer": None, "reasons": []}
            asr = {"mode": "unavailable", "text": None, "audio_start": None, "audio_end": None, "segment_refs": [], "min_word_probability": None}
        uid = short_id("utt", source_sha, c["caption_segment_id"])
        needs = bool(flags) or alignment["status"] in ("disagree", "no_asr_overlap") or spk["attribution"] != "label_stable"
        out.append({
            "schema": "vbench.utterance/1",
            "utterance_id": uid,
            "caption": {
                "caption_segment_id": c["caption_segment_id"],
                "text": c["text"],
                "alternatives": c["alternatives"],
                "display_start": c["display_start"],
                "display_end": c["display_end"],
                "timing": c["timing"],
                **({"crop": c["representative_crop"]} if c.get("representative_crop") else {}),
            },
            "speaker": spk,
            "asr": asr,
            "alignment": alignment,
            "verbatim": None,
            "flags": sorted(set(flags)),
            # A labelled caption is presumed in-game speech; no label means the
            # machine cannot tell speech from narration, so it stays undecided.
            "eligibility": "in_game_speech" if spk["seat"] is not None else "unknown",
            "availability": {
                "status": "anchored",
                "public_at": c["display_end"],
                "basis": "caption display end (speech is public once finished)",
                "evidence_refs": [{"kind": "caption_segment", "id": c["caption_segment_id"], "video_time": c["display_end"]}],
            },
            "review_status": "needs_review" if needs else "machine_candidate",
            "provenance": provenance,
        })

    # ASR speech with no caption at all: unsubtitled speech candidates.
    runs: list[list[tuple[dict, str]]] = []
    for w, sid in sorted(unassigned, key=lambda x: x[0]["start"]):
        if runs and w["start"] - runs[-1][-1][0]["end"] <= 0.8:
            runs[-1].append((w, sid))
        else:
            runs.append([(w, sid)])
    for run in runs:
        text = "".join(w["word"] for w, _ in run)
        if len(normalize_for_compare(text)) < 2:
            continue
        s, e = run[0][0]["start"], run[-1][0]["end"]
        spk = attribute_speaker(speakers, s, e)
        out.append({
            "schema": "vbench.utterance/1",
            "utterance_id": short_id("utt", source_sha, "asr_only", round(s, 3), text),
            "caption": None,
            "speaker": spk,
            "asr": {
                "mode": asr_mode, "text": text, "audio_start": s, "audio_end": e,
                "segment_refs": sorted({sid for _, sid in run}),
                "min_word_probability": round(min((w["probability"] or 0) for w, _ in run), 4),
            },
            "alignment": {"status": "asr_only", "cer": None, "reasons": []},
            "verbatim": None,
            "flags": ["asr_only"],
            "eligibility": "unknown",
            "availability": {
                "status": "anchored",
                "public_at": e,
                "basis": "ASR word end (unsubtitled speech)",
                "evidence_refs": [{"kind": "asr_segment", "id": sid} for sid in sorted({sid for _, sid in run})],
            },
            "review_status": "needs_review",
            "provenance": provenance,
        })
    return sorted(out, key=lambda u: (u["availability"]["public_at"], u["utterance_id"]))
