"""Caption persistence, OCR jitter, brief/separated captions, speakers, ASR disagreement."""

from synth import SOURCE, DecodingOcr, FrameSpec, frames, pilot_cfg, timeline, write_layout

from vbench.changes import SamplingConfig, scan
from vbench.layout import load_layout
from vbench.pipeline import run_extract
from vbench.review import build_review_queue
from vbench.util import read_jsonl

CAPS = {1: "我觉得5号可能干净一点啊", 2: "对", 3: "过了", 4: "然后点出了十号他可能是张莫甘娜", 5: "短"}
LABELS = {3: "3 小明", 5: "5 阿强", 7: "7 老王"}


def _run(tmp_path, specs, asr=None, **cfg_over):
    layout = write_layout(tmp_path)
    cfg = pilot_cfg(layout, **cfg_over)
    engine = DecodingOcr(CAPS, LABELS)
    stats = run_extract(cfg, SOURCE, frames=frames(specs), fps=30.0, engine=engine, asr_segments_override=asr, cache_root=None)
    from vbench.paths import run_paths

    pub = run_paths(cfg["run_id"]).public
    return stats, read_jsonl(pub / "caption_segments.jsonl"), read_jsonl(pub / "utterances.jsonl"), engine, cfg


def test_stable_caption_persists_as_one_segment_with_frame_exact_bounds(tmp_path):
    specs = timeline((13, FrameSpec()), (60, FrameSpec(caption=1, label=5)), (20, FrameSpec()))
    stats, caps, utts, _, _ = _run(tmp_path, specs)
    assert stats["validation_error_count"] == 0
    assert len(caps) == 1
    assert abs(caps[0]["display_start"] - 13 / 30) < 1e-3
    assert abs(caps[0]["display_end"] - 73 / 30) < 1e-3
    assert caps[0]["text"] == CAPS[1]
    assert utts[0]["speaker"]["seat"] == 5 and utts[0]["speaker"]["attribution"] == "label_stable"


def test_ocr_jitter_is_merged_but_kept_as_alternative(tmp_path):
    # Dot below the pixel-diff threshold: same segment, but guard OCR misreads it.
    specs = timeline((60, FrameSpec(caption=1, label=5)), (20, FrameSpec(caption=1, label=5, jitter=True)), (10, FrameSpec()))
    _, caps, _, _, _ = _run(tmp_path, specs)
    assert len(caps) == 1
    assert caps[0]["text"] == CAPS[1]
    assert CAPS[1] + "了" in caps[0]["alternatives"]
    # Within jitter tolerance it is a raw alternative, not evidence of a missed change.
    assert "guard_mismatch" not in caps[0]["flags"]


def test_guard_reading_a_different_sentence_flags_a_possible_missed_change(tmp_path):
    layout = write_layout(tmp_path)
    cfg = pilot_cfg(layout)
    engine = DecodingOcr(CAPS, LABELS, jitter_suffix="，但是下一句完全是另外一件事情了")
    specs = timeline((60, FrameSpec(caption=2, label=5)), (20, FrameSpec(caption=2, label=5, jitter=True)), (10, FrameSpec()))
    run_extract(cfg, SOURCE, frames=frames(specs), fps=30.0, engine=engine, cache_root=None)
    from vbench.paths import run_paths

    caps = read_jsonl(run_paths(cfg["run_id"]).public / "caption_segments.jsonl")
    assert len(caps) == 1 and "guard_mismatch" in caps[0]["flags"]
    utts = read_jsonl(run_paths(cfg["run_id"]).public / "utterances.jsonl")
    assert utts[0]["review_status"] == "needs_review"


def test_brief_caption_between_samples_is_refined_to_exact_frames(tmp_path):
    # 3-frame caption 5 wedged between caption 1 and caption 3; the sample after it differs.
    specs = timeline((32, FrameSpec(caption=1, label=5)), (3, FrameSpec(caption=5, label=5)), (40, FrameSpec(caption=3, label=5)))
    _, caps, _, _, _ = _run(tmp_path, specs)
    texts = [c["text"] for c in caps]
    assert texts == [CAPS[1], CAPS[5], CAPS[3]]
    brief = caps[1]
    assert abs(brief["display_start"] - 32 / 30) < 1e-3 and abs(brief["display_end"] - 35 / 30) < 1e-3
    assert "short" in brief["flags"]


def test_change_that_reverts_between_coarse_samples_is_a_measured_recall_limit(tmp_path):
    layout = load_layout(write_layout(tmp_path))
    specs = timeline((32, FrameSpec(caption=1)), (3, FrameSpec(caption=5)), (40, FrameSpec(caption=1)))
    cfg = pilot_cfg(tmp_path)["sampling"]
    coarse, _ = scan(frames(specs), layout, SamplingConfig.from_dict(cfg), 30.0)
    dense, _ = scan(frames(specs), layout, SamplingConfig.from_dict(dict(cfg, coarse_step_frames=1)), 30.0)
    assert len(coarse["subtitle"]) == 1  # invisible to coarse sampling
    assert len(dense["subtitle"]) == 3  # the dense check sees it


def test_separated_identical_captions_stay_separate(tmp_path):
    specs = timeline((20, FrameSpec(caption=2, label=3)), (25, FrameSpec()), (20, FrameSpec(caption=2, label=3)), (5, FrameSpec()))
    _, caps, _, _, _ = _run(tmp_path, specs)
    assert [c["text"] for c in caps] == ["对", "对"]


def test_identical_text_by_different_speakers_is_not_merged(tmp_path):
    # Gap (0.1 s) is inside merge_gap_s, so only the speaker difference keeps them apart.
    specs = timeline((30, FrameSpec(caption=2, label=3)), (3, FrameSpec()), (30, FrameSpec(caption=2, label=5)), (6, FrameSpec()))
    _, caps, utts, _, _ = _run(tmp_path, specs)
    assert len(caps) == 2
    assert [u["speaker"]["seat"] for u in utts] == [3, 5]


def test_caption_without_label_has_null_speaker_and_undecided_eligibility(tmp_path):
    specs = timeline((30, FrameSpec(caption=3, label=None)), (6, FrameSpec()))
    _, _, utts, _, _ = _run(tmp_path, specs)
    u = utts[0]
    assert u["speaker"]["seat"] is None
    assert u["speaker"]["attribution"] == "no_label"
    assert u["eligibility"] == "unknown"


def test_label_change_inside_caption_is_flagged_not_assigned_silently(tmp_path):
    specs = timeline((30, FrameSpec(caption=1, label=5)), (30, FrameSpec(caption=1, label=7)), (6, FrameSpec()))
    stats, caps, utts, _, cfg = _run(tmp_path, specs)
    assert len(caps) == 1
    u = utts[0]
    assert u["speaker"]["attribution"] == "label_transition"
    assert "label_transition" in u["flags"]
    assert {l["seat"] for l in u["speaker"]["labels_seen"]} == {5, 7}
    q = build_review_queue(cfg, SOURCE["source_id"])
    assert q["reason_counts"].get("label_transition") == 1


def _asr(start, end, text):
    n = len(text)
    step = (end - start) / n
    return {
        "schema": "vbench.asr_segment/1", "asr_segment_id": "asr-0123456789abcdef", "audio_start": start, "audio_end": end,
        "text": text, "avg_logprob": -0.3, "no_speech_prob": 0.01,
        "words": [{"start": round(start + i * step, 3), "end": round(start + (i + 1) * step, 3), "word": ch, "probability": 0.9} for i, ch in enumerate(text)],
        "engine": {"name": "fake", "version_key": "fake"},
    }


def test_ocr_asr_disagreement_survives_review_export(tmp_path):
    specs = timeline((60, FrameSpec(caption=1, label=5)), (6, FrameSpec()))
    asr = [_asr(0.1, 1.9, "我觉得三号不可能干净")]
    _, caps, utts, _, cfg = _run(tmp_path, specs, asr=asr)
    u = utts[0]
    assert u["caption"]["text"] == CAPS[1]  # caption untouched
    assert u["asr"]["text"] == "我觉得三号不可能干净"  # ASR untouched
    assert u["alignment"]["status"] in ("minor_diff", "disagree")
    assert "numeral_mismatch" in u["alignment"]["reasons"]
    assert "negation_mismatch" in u["alignment"]["reasons"]
    build_review_queue(cfg, SOURCE["source_id"])
    from vbench.paths import run_paths

    item = [it for it in read_jsonl(run_paths(cfg["run_id"]).review / "queue.jsonl") if it["target"]["id"] == u["utterance_id"]][0]
    assert "numeral_mismatch" in item["reasons"]
    assert any("我觉得三号不可能干净" in d for d in item["details"])
    assert item["candidate"]["caption_text"] == CAPS[1]


def test_much_longer_audio_than_caption_suggests_overlap_and_unsubtitled_speech_is_kept(tmp_path):
    specs = timeline((30, FrameSpec(caption=2, label=3)), (60, FrameSpec()), (6, FrameSpec()))
    asr = [_asr(0.0, 0.9, "对对对我跟你说这个车肯定不能过"), _asr(2.0, 2.8, "等一下我还没说完")]
    _, _, utts, _, _ = _run(tmp_path, specs, asr=asr)
    cap_u = [u for u in utts if u["caption"]][0]
    assert "overlap_suspected" in cap_u["flags"]
    asr_only = [u for u in utts if u["caption"] is None]
    assert len(asr_only) == 1 and asr_only[0]["asr"]["text"] == "等一下我还没说完"
    assert asr_only[0]["review_status"] == "needs_review" and asr_only[0]["eligibility"] == "unknown"


def test_subtitle_only_output_is_labelled_when_asr_is_unavailable(tmp_path):
    specs = timeline((30, FrameSpec(caption=2, label=3)), (6, FrameSpec()))
    _, _, utts, _, _ = _run(tmp_path, specs, asr=None)
    assert utts[0]["asr"]["mode"] == "unavailable"
    assert utts[0]["alignment"]["status"] == "asr_unavailable"
    assert "caption_only" in utts[0]["flags"]
