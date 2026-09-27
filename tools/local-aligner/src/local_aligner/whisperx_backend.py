from __future__ import annotations

import hashlib
import importlib.metadata
from pathlib import Path

from .contracts import AlignRequest, AlignResult, BackendIdentity
from .model_lock import load_model_lock
from .normalization import (
    map_characters_to_stable_tokens,
    normalize_alignment_text,
    strip_speech_controls,
)

SAMPLE_RATE = 48_000


def align_known_transcript(request: AlignRequest) -> AlignResult:
    if not request.audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {request.audio_path}")

    import whisperx
    from huggingface_hub import snapshot_download

    lock = load_model_lock()
    whisperx_lock = lock["whisperx"]
    model_lock = whisperx_lock["alignment_model"]
    model_directory = snapshot_download(
        repo_id=model_lock["repo_id"],
        revision=model_lock["revision"],
        cache_dir=request.options.model_dir,
        local_files_only=request.options.model_cache_only,
    )
    align_model, metadata = whisperx.load_align_model(
        language_code=request.language,
        device=request.options.device,
        model_name=model_directory,
        model_dir=request.options.model_dir,
        model_cache_only=request.options.model_cache_only,
    )
    audio = whisperx.load_audio(str(request.audio_path))
    transcript = [
        {
            "text": strip_speech_controls(request.text),
            "start": request.segment.start_sample / SAMPLE_RATE,
            "end": request.segment.end_sample / SAMPLE_RATE,
        }
    ]
    aligned = whisperx.align(
        transcript,
        align_model,
        metadata,
        audio,
        request.options.device,
        interpolate_method=request.options.interpolate_method,
        return_char_alignments=True,
        print_progress=False,
    )
    characters = [
        character
        for segment in aligned.get("segments", [])
        for character in segment.get("chars", [])
    ]
    tokens, unmatched, warnings = map_characters_to_stable_tokens(
        request.stable_tokens,
        characters,
        SAMPLE_RATE,
        request.segment.start_sample,
        request.segment.end_sample,
    )
    return AlignResult(
        backend=BackendIdentity(
            name="whisperx",
            model=model_lock["repo_id"],
            model_revision=model_lock["revision"],
            package_version=importlib.metadata.version("whisperx"),
            device=request.options.device,
            config={
                "language": request.language,
                "interpolate_method": request.options.interpolate_method,
                "return_char_alignments": True,
            },
        ),
        tokens=tokens,
        unmatched_ranges=unmatched,
        warnings=warnings,
        audio_sha256=_sha256_file(request.audio_path),
        text_sha256=hashlib.sha256(normalize_alignment_text(request.text).encode("utf-8")).hexdigest(),
    )


def _sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
