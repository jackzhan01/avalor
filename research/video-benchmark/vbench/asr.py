"""Local timestamped ASR (faster-whisper). No network calls at transcription time.

Model weights are downloaded once by `vbench doctor --fetch-asr-model` into the
ignored data root; normal tests never touch this module's backend.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .cache import StageCache
from .util import short_id

ASR_STAGE_VERSION = "1"


@dataclass
class AsrConfig:
    backend: str = "faster-whisper"
    model: str = "large-v3"
    device: str = "cuda"
    compute_type: str = "float16"
    language: str = "zh"
    beam_size: int = 5
    vad_filter: bool = True
    # A Mandarin sentence as prompt nudges Whisper to simplified characters. It
    # biases orthography only; the text is still compared, never overwritten.
    initial_prompt: str | None = "以下是普通话的句子。"
    agree_cer: float = 0.15
    minor_cer: float = 0.4
    pad_s: float = 0.3

    @classmethod
    def from_dict(cls, d: dict) -> "AsrConfig":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    def params(self) -> dict:
        return {k: getattr(self, k) for k in ("model", "device", "compute_type", "language", "beam_size", "vad_filter", "initial_prompt")}


def engine_version(cfg: AsrConfig) -> str:
    from importlib.metadata import version

    return f"faster-whisper=={version('faster-whisper')};ctranslate2=={version('ctranslate2')};model={cfg.model}"


def transcribe_interval(
    audio_path: Path, audio_sha: str, start: float, end: float, cfg: AsrConfig, models_dir: Path, cache: StageCache
) -> tuple[list[dict], bool]:
    """Returns raw ASR segments with absolute (video) times, and whether it was a cache hit."""
    key = StageCache.key(
        "asr", ASR_STAGE_VERSION, audio=audio_sha, start=start, end=end, params=cfg.params(), engine=engine_version(cfg)
    )

    def compute():
        from faster_whisper import WhisperModel

        from .media import load_audio_mono16k

        audio = load_audio_mono16k(audio_path, start, end)
        model = WhisperModel(cfg.model, device=cfg.device, compute_type=cfg.compute_type, download_root=str(models_dir))
        segments, _info = model.transcribe(
            audio,
            language=cfg.language,
            beam_size=cfg.beam_size,
            word_timestamps=True,
            vad_filter=cfg.vad_filter,
            initial_prompt=cfg.initial_prompt,
            condition_on_previous_text=False,
        )
        out = []
        for s in segments:
            out.append({
                "start": round(start + s.start, 3),
                "end": round(start + s.end, 3),
                "text": s.text,
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                "words": [
                    {"start": round(start + w.start, 3), "end": round(start + w.end, 3), "word": w.word, "probability": w.probability}
                    for w in (s.words or [])
                ],
            })
        return out

    raw, hit = cache.get_or_compute("asr", key, compute)
    return raw, hit


def asr_segment_records(raw: list[dict], source_sha: str, cfg: AsrConfig, version_key: str) -> list[dict]:
    return [
        {
            "schema": "vbench.asr_segment/1",
            "asr_segment_id": short_id("asr", source_sha, s["start"], s["end"], s["text"]),
            "audio_start": s["start"],
            "audio_end": s["end"],
            "text": s["text"],
            "avg_logprob": s["avg_logprob"],
            "no_speech_prob": s["no_speech_prob"],
            "words": s["words"],
            "engine": {"name": "faster-whisper", "version_key": version_key, **{k: v for k, v in cfg.params().items() if k != "initial_prompt"}},
        }
        for s in raw
    ]
