from __future__ import annotations

import difflib

from .contracts import AlignRequest
from .model_lock import load_model_lock
from .normalization import normalize_alignment_text


def run_shadow_asr(request: AlignRequest) -> dict[str, object]:
    from faster_whisper import WhisperModel

    lock = load_model_lock()["faster_whisper_shadow"]
    device = request.options.device
    compute_type = lock["compute_type_cuda"] if device.startswith("cuda") else lock["compute_type_cpu"]
    model = WhisperModel(
        lock["model"],
        device=device,
        compute_type=compute_type,
        download_root=request.options.model_dir,
    )
    segments_iterator, info = model.transcribe(
        str(request.audio_path),
        language="zh",
        beam_size=lock["beam_size"],
        word_timestamps=True,
        vad_filter=lock["vad_filter"],
    )
    segments = []
    recognized_parts = []
    for segment in segments_iterator:
        recognized_parts.append(segment.text)
        segments.append(
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "avg_logprob": segment.avg_logprob,
                "no_speech_prob": segment.no_speech_prob,
                "words": [
                    {
                        "start": word.start,
                        "end": word.end,
                        "text": word.word,
                        "probability": word.probability,
                    }
                    for word in (segment.words or [])
                ],
            }
        )
    recognized_text = "".join(recognized_parts)
    expected = normalize_alignment_text(request.text)
    actual = normalize_alignment_text(recognized_text)
    return {
        "schema_version": "1",
        "backend": {
            "name": "faster-whisper",
            "model": lock["model"],
            "device": device,
            "compute_type": compute_type,
        },
        "language": info.language,
        "language_probability": info.language_probability,
        "recognized_text": recognized_text,
        "text_similarity": difflib.SequenceMatcher(a=expected, b=actual).ratio(),
        "segments": segments,
        "diagnostic_only": True,
    }
