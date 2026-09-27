from __future__ import annotations

import importlib.metadata
import sys
from typing import Any

from .model_lock import load_model_lock
from .runtime import configure_ffmpeg_environment


def inspect_environment(device: str = "cuda", load_model: bool = False) -> dict[str, Any]:
    lock = load_model_lock()
    whisperx_lock = lock["whisperx"]
    model_lock = whisperx_lock["alignment_model"]
    checks = []
    versions: dict[str, str] = {}
    for package in ["whisperx", "torch", "torchaudio", "faster-whisper"]:
        try:
            versions[package] = importlib.metadata.version(package)
            checks.append({"id": f"package_{package}", "passed": True, "detail": versions[package]})
        except importlib.metadata.PackageNotFoundError:
            checks.append({"id": f"package_{package}", "passed": False, "detail": "missing"})

    torch_status: dict[str, object] = {"cuda_available": False}
    try:
        import torch

        cuda_available = torch.cuda.is_available()
        torch_status = {
            "cuda_available": cuda_available,
            "cuda_version": torch.version.cuda,
            "device_count": torch.cuda.device_count() if cuda_available else 0,
            "device_name": torch.cuda.get_device_name(0) if cuda_available else None,
        }
        checks.append({
            "id": "requested_device",
            "passed": not device.startswith("cuda") or cuda_available,
            "detail": str(torch_status),
        })
    except Exception as error:  # pragma: no cover - exercised by doctor before sync
        checks.append({"id": "requested_device", "passed": False, "detail": str(error)})

    ffmpeg_path = configure_ffmpeg_environment()
    checks.append({"id": "ffmpeg", "passed": bool(ffmpeg_path), "detail": ffmpeg_path or "missing"})
    model_loaded = False
    if load_model and all(check["passed"] for check in checks):
        try:
            import whisperx
            from huggingface_hub import snapshot_download

            model_directory = snapshot_download(
                repo_id=model_lock["repo_id"],
                revision=model_lock["revision"],
            )
            whisperx.load_align_model(
                language_code="zh",
                device=device,
                model_name=model_directory,
            )
            model_loaded = True
            checks.append({"id": "alignment_model_load", "passed": True, "detail": model_directory})
        except Exception as error:
            checks.append({
                "id": "alignment_model_load",
                "passed": False,
                "detail": f"{type(error).__name__}: {error}",
            })

    package_version = versions.get("whisperx", whisperx_lock["package_version"])
    cache_identity = {
        "name": "whisperx",
        "model": model_lock["repo_id"],
        "model_revision": model_lock["revision"],
        "package_version": package_version,
        "device": device,
        "config": {
            "language": "zh",
            "interpolate_method": whisperx_lock["interpolate_method"],
            "return_char_alignments": True,
        },
    }
    return {
        "schema_version": "1",
        "ready": all(check["passed"] for check in checks),
        "python": sys.version.split()[0],
        "checks": checks,
        "torch": torch_status,
        "model_loaded": model_loaded,
        "cache_identity": cache_identity,
    }
